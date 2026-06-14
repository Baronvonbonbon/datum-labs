// Returning-user load driver (R1.5). Unlike load.mjs — which fires a FRESH
// random user per claim (worst case for aggregation: distinct users ≈ claims,
// so the indexer's compressionVsClaims drops below 1) — this draws from a FIXED
// user pool with a skewed activity distribution. A few heavy users span many
// campaigns, so distinct users ≪ claims and the settlement-aggregation
// compression ratio (../indexer /api/aggregation) reflects a realistic market.
//
// Why this shape: claim hash-chains are per (user, campaign, actionType) with an
// incrementing nonce, so concurrent claims on the SAME chain race the nonce. We
// model reuse on the (user × campaign) bipartite graph: distribute K impressions
// across pairs by the activity distribution, then emit one claim per distinct
// pair with eventCount = the impressions that landed on it. "Returning" shows up
// as a user appearing across many campaigns (one payout row, many claims).
//
// SLIM chaining: each claim is anchored to its on-chain chain head — firstNonce =
// lastNonce+1, prevHash = lastClaimHash — read fresh before building. Distinct
// pairs are independent chains (run concurrently); claims within a pair are
// serialized. This makes the driver RESUMABLE: re-running with the same --seed
// advances each user's chain (nonce 2,3,…) instead of re-posting a stale nonce=1,
// so cross-run reuse actually settles. --per-pair N drives a real N-deep chain
// per pair (returns on the SAME campaign), each claim waiting for the prior.
//
// Usage:
//   node scripts/load-returning.mjs --campaigns 158,169 --pool 50 --impressions 800
// Flags (defaults in []):
//   --campaigns CSV    campaign ids to load                       [158]
//   --pool N           distinct users in the pool                 [50]
//   --impressions K    total impressions to distribute            [500]
//   --skew F           Zipf exponent for user activity (0=uniform) [1.0]
//   --max-events N     cap eventCount per (user,campaign) claim    [25]
//   --per-pair N       sequential claims per pair (real N-deep chain) [1]
//   --seed S           derive a DETERMINISTIC pool from S so the
//                      same users return ACROSS runs               [random]
//   --rate PLANCK      override CPM (else each campaign's bid)
//   --publisher 0x     publisher for OPEN campaigns
//   --concurrency N    parallel POSTs                              [10]
//   --relay URL [http://127.0.0.1:3400]  --rpc URL  --addresses PATH
//   --dry              print the planned distribution, don't POST
import { JsonRpcProvider, Contract, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { loadAddresses } from "./preflight.mjs";
import { resolveWork, getMetrics } from "./lib/loadrun.mjs";
import { buildEnvelope, powTarget, postClaim, freshUser } from "./lib/claim.mjs";

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const name = argv[i].slice(2);
    if (name === "dry") a[name] = true;
    else a[name] = argv[++i];
  }
  return a;
}

// Deterministic pool address from a seed (so the same users return across runs):
// last 20 bytes of keccak256("<seed>:<i>"). Random fallback when no seed given.
function buildPool(size, seed) {
  if (!seed) return Array.from({ length: size }, () => freshUser());
  return Array.from({ length: size }, (_, i) => getAddress("0x" + keccak256(toUtf8Bytes(`${seed}:${i}`)).slice(-40)));
}

// Zipf-ish weights over a pool: weight_i ∝ 1/(i+1)^skew. skew=0 → uniform.
// Returns a sampler drawing an index by cumulative weight.
function zipfSampler(n, skew) {
  const w = Array.from({ length: n }, (_, i) => 1 / Math.pow(i + 1, skew));
  const total = w.reduce((s, x) => s + x, 0);
  const cum = [];
  let acc = 0;
  for (const x of w) cum.push((acc += x) / total);
  return () => {
    const r = Math.random();
    for (let i = 0; i < cum.length; i++) if (r <= cum[i]) return i;
    return cum.length - 1;
  };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const relay = (a.relay || "http://127.0.0.1:3400").replace(/\/+$/, "");
  const provider = new JsonRpcProvider(a.rpc || process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io");
  const ADDR = loadAddresses(a.addresses);
  const campaigns = (a.campaigns || "158").split(",").map((s) => BigInt(s.trim()));

  const poolSize = Number(a.pool || 50);
  const impressions = Number(a.impressions || 500);
  const skew = Number(a.skew ?? 1.0);
  const maxEvents = Number(a["max-events"] || 25);

  const { work, m0 } = await resolveWork({
    relay, provider, ADDR, campaigns,
    rateOverride: a.rate != null ? BigInt(a.rate) : null,
    publisherOverride: a.publisher || null,
  });
  if (!work.length) {
    console.error("No loadable campaigns. Check the relay's keys match a campaign's publisher/advertiser.");
    process.exit(1);
  }

  // Build the pool + distribute impressions across (user, campaign) pairs.
  const users = buildPool(poolSize, a.seed);
  const pick = zipfSampler(poolSize, skew);
  const counts = new Map(); // "userIdx|workIdx" -> eventCount (capped)
  for (let k = 0; k < impressions; k++) {
    const key = `${pick()}|${Math.floor(Math.random() * work.length)}`;
    counts.set(key, Math.min((counts.get(key) || 0) + 1, maxEvents));
  }

  // Materialize one nonce=1 claim per distinct (user, campaign) pair.
  const claims = [];
  const seenUsers = new Set(), seenCampaigns = new Set();
  for (const [key, ec] of counts) {
    const [ui, wi] = key.split("|").map(Number);
    claims.push({ user: users[ui], w: work[wi], eventCount: BigInt(ec) });
    seenUsers.add(ui);
    seenCampaigns.add(work[wi].cid.toString());
  }

  const totalImpr = [...counts.values()].reduce((s, x) => s + x, 0);
  const aggRows = seenUsers.size + new Set(work.map((w) => w.publisher)).size + seenCampaigns.size + 1;
  console.log(`\nPlan (seed=${a.seed ?? "random"}, skew=${skew}):`);
  console.log(`  pool ${poolSize} users · ${claims.length} claims (distinct user×campaign pairs)`);
  console.log(`  ${totalImpr} impressions · ${seenUsers.size} active users · ${seenCampaigns.size} campaigns`);
  console.log(`  → if aggregated this epoch: ~${aggRows} on-chain rows  (compressionVsClaims ≈ ${(claims.length / aggRows).toFixed(2)}, vsImpressions ≈ ${(totalImpr / aggRows).toFixed(2)})`);
  console.log(`  (the real number comes from ../indexer /api/aggregation after these settle)`);

  if (a.dry) {
    console.log("\n--dry: not posting.");
    return;
  }

  // SLIM chaining: each claim is anchored to the on-chain chain head for its
  // (user, campaign, actionType) — firstNonce = lastNonce+1, prevHash =
  // lastClaimHash — read fresh before building so PoW + both signatures bind to
  // the value the contract will assign. This makes the driver:
  //   • RESUMABLE / cross-run: re-running with the same --seed advances each
  //     user's chain (nonce 2, 3, …) instead of re-posting a stale nonce=1;
  //   • multi-claim: --per-pair N emits N sequential claims per pair, each
  //     waiting for the prior to settle (a real hash-chain), exercising returns
  //     on the SAME campaign, not just across campaigns.
  // Distinct pairs are independent chains, so pairs still run concurrently; only
  // claims WITHIN a pair are serialized (the nonce-race the old design avoided).
  const ACTION = 0; // view
  const perPair = Math.max(1, Number(a["per-pair"] || 1));
  const settlement = new Contract(ADDR.settlement, [
    "function lastNonce(address,uint256,uint8) view returns (uint256)",
    "function lastClaimHash(address,uint256,uint8) view returns (bytes32)",
  ], provider);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitForNonce = async (user, cid, target, tries = 40) => {
    for (let i = 0; i < tries; i++) { if ((await settlement.lastNonce(user, cid, ACTION)) >= target) return true; await sleep(1500); }
    return false;
  };

  console.log(`\nFiring ${claims.length} pair-chains × ${perPair} claim(s), concurrency ${a.concurrency || 10}…`);
  let accepted = 0, rejected = 0, stalled = 0;
  await pool(claims, Number(a.concurrency || 10), async (c) => {
    for (let j = 0; j < perPair; j++) {
      const head = await provider.getBlockNumber();
      const lastN = await settlement.lastNonce(c.user, c.w.cid, ACTION);
      const prevHash = await settlement.lastClaimHash(c.user, c.w.cid, ACTION);
      const firstNonce = lastN + 1n;
      // PoW is per (user, eventCount) when enforced; w.powTarget != null gates it.
      const tgt = c.w.powTarget != null ? await powTarget(provider, ADDR.powEngine, c.user, c.eventCount).catch(() => null) : null;
      const { envelope } = buildEnvelope({
        campaignId: c.w.cid, publisher: c.w.publisher, user: c.user, rateWei: c.w.rateWei, head,
        eventCount: c.eventCount, firstNonce, previousClaimHash: prevHash,
        expectedRelaySigner: c.w.expectedRelaySigner, expectedAdvertiserRelaySigner: c.w.expectedAdvertiserRelaySigner,
        powTarget: tgt,
      });
      const { status, body } = await postClaim(relay, envelope);
      if (!(status === 202 && body.ok)) { rejected++; if (rejected <= 5) console.log(`  POST rejected: ${status} ${JSON.stringify(body)}`); break; }
      accepted++;
      // Serialize the chain: the next claim on this pair needs this one settled
      // (firstNonce must equal lastNonce+1 at submission). Single-claim pairs
      // don't wait — they're independent and settle in parallel.
      if (perPair > 1 && !(await waitForNonce(c.user, c.w.cid, firstNonce))) { stalled++; console.log(`  chain stalled at nonce ${firstNonce} (${c.user.slice(0, 10)}…/${c.w.cid})`); break; }
    }
  });
  console.log(`Posted: ${accepted} accepted, ${rejected} rejected${stalled ? `, ${stalled} chains stalled` : ""}`);

  const after = await getMetrics(relay);
  console.log("\nRelay delta:");
  for (const k of ["claimsReceived", "claimsSubmitted", "claimsConfirmed", "claimErrors"]) {
    console.log(`  ${k.padEnd(22)} ${m0[k] ?? 0} → ${after[k] ?? 0}`);
  }
  console.log(`\nNow backfill the indexer + read the real compression ratio:`);
  console.log(`  (cd ../indexer && node src/index.js backfill && curl -s localhost:4319/api/aggregation | less)`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
