// Load core — shared by load.mjs and scenario.mjs. Resolves each campaign's
// publisher, preflights it against the relay's configured signers, then fires
// N fresh users/campaign at the relay and waits for the queue to drain.
import { Contract, getAddress, ZeroAddress } from "ethers";
import { runPreflight } from "../preflight.mjs";
import { buildEnvelope, powTarget, postClaim, freshUser } from "./claim.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

export async function getMetrics(relay) {
  return (await fetch(`${relay}/metrics`)).json();
}

// Resolve which campaigns are loadable with the relay's configured keys.
export async function resolveWork({ relay, provider, ADDR, campaigns, rateOverride = null, publisherOverride = null, log = console.log }) {
  const m0 = await getMetrics(relay);
  const relaySigner = m0.signer ? getAddress(m0.signer) : null;
  const advSigner = m0.advertiserSigner ? getAddress(m0.advertiserSigner) : null;
  const camp = new Contract(ADDR.campaigns, ["function getCampaignPublisher(uint256) view returns (address)"], provider);

  const work = [];
  for (const cid of campaigns) {
    let publisher = await camp.getCampaignPublisher(cid).catch(() => ZeroAddress);
    if (publisher === ZeroAddress) {
      if (!publisherOverride) { log(`  campaign ${cid}: open, no publisher override → skip`); continue; }
      publisher = getAddress(publisherOverride);
    } else publisher = getAddress(publisher);

    const pf = await runPreflight({ campaignId: cid, publisher, rate: rateOverride, relaySignerArg: relaySigner, advSignerArg: advSigner, provider, ADDR });
    if (pf.blockers.length) { log(`  campaign ${cid}: NO-GO (${pf.blockers.map((b) => b.label).join(", ")}) → skip`); continue; }

    const tgt = await powTarget(provider, ADDR.powEngine, publisher, 1n).catch(() => null);
    work.push({
      cid, publisher, rateWei: pf.plan.rate, powTarget: tgt,
      expectedRelaySigner: pf.plan.pubSigPath?.expectedRelay ?? ZeroAddress,
      expectedAdvertiserRelaySigner: pf.plan.advSigPath?.expectedAdv ?? ZeroAddress,
    });
    log(`  campaign ${cid}: GO  publisher=${publisher} rate=${pf.plan.rate} pow=${tgt != null ? "on" : "off"}`);
  }
  return { work, m0 };
}

// Fire usersPer fresh claims at each work item; wait for the relay to drain.
export async function runLoad({ relay, provider, ADDR, work, m0, usersPer, concurrency = 10, log = console.log }) {
  const head = await provider.getBlockNumber();
  const jobs = [];
  for (const w of work) for (let u = 0; u < usersPer; u++) jobs.push(w);
  log(`\nFiring ${jobs.length} claims (${work.length} campaigns × ${usersPer} users), concurrency ${concurrency}…`);

  let accepted = 0, rejected = 0;
  const t0 = Date.now();
  await pool(jobs, concurrency, async (w) => {
    const { envelope } = buildEnvelope({
      campaignId: w.cid, publisher: w.publisher, user: freshUser(), rateWei: w.rateWei, head,
      expectedRelaySigner: w.expectedRelaySigner, expectedAdvertiserRelaySigner: w.expectedAdvertiserRelaySigner,
      powTarget: w.powTarget,
    });
    const { status, body } = await postClaim(relay, envelope);
    if (status === 202 && body.ok) accepted++;
    else { rejected++; if (rejected <= 5) log(`  POST rejected: ${status} ${JSON.stringify(body)}`); }
  });
  const postSecs = (Date.now() - t0) / 1000;
  log(`Posted: ${accepted} accepted, ${rejected} rejected in ${postSecs.toFixed(1)}s`);

  // True throughput = time to CONFIRM all settlements on-chain (not just submit).
  const target = (m0.claimsConfirmed ?? 0) + accepted;
  log(`Confirming on-chain (claimsConfirmed ≥ ${target})…`);
  const deadline = Date.now() + 300000;
  let m = m0;
  while (Date.now() < deadline) {
    m = await getMetrics(relay);
    if ((m.claimsConfirmed ?? 0) >= target) break;
    await sleep(2000);
  }
  const confirmSecs = (Date.now() - t0) / 1000;
  const confirmed = (m.claimsConfirmed ?? 0) - (m0.claimsConfirmed ?? 0);
  const tps = confirmed > 0 ? confirmed / confirmSecs : 0;
  log(`Confirmed ${confirmed}/${accepted} in ${confirmSecs.toFixed(1)}s → ${(tps * 60).toFixed(1)} settlements/min`);
  return { accepted, rejected, confirmed, postSecs, confirmSecs, tps, after: m };
}
