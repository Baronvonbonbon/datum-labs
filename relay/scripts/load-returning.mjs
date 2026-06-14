// Returning-user load driver (R1.5). Unlike load.mjs — which fires a FRESH
// random user per claim (worst case for aggregation: distinct users ≈ claims,
// so the indexer's compressionVsClaims drops below 1) — this draws from a FIXED
// user pool with a skewed activity distribution. A few heavy users span many
// campaigns, so distinct users ≪ claims and the settlement-aggregation
// compression ratio (../indexer /api/aggregation) reflects a realistic market.
//
// Why this shape: claim hash-chains are per (user, campaign, actionType) with an
// incrementing nonce. Firing several claims on the SAME chain concurrently races
// the nonce and reverts (gap, reasonCode 7). So we model reuse on the
// (user × campaign) bipartite graph instead: distribute K impressions across
// pairs by the activity distribution, then emit ONE nonce=1 claim per distinct
// pair with eventCount = the impressions that landed on it. Every claim is an
// independent chain — no ordering hazard — and "returning" shows up as a user
// appearing across many campaigns (one payout row, many claims/impressions).
//
// Usage:
//   node scripts/load-returning.mjs --campaigns 158,169 --pool 50 --impressions 800
// Flags (defaults in []):
//   --campaigns CSV    campaign ids to load                       [158]
//   --pool N           distinct users in the pool                 [50]
//   --impressions K    total impressions to distribute            [500]
//   --skew F           Zipf exponent for user activity (0=uniform) [1.0]
//   --max-events N     cap eventCount per (user,campaign) claim    [25]
//   --seed S           derive a DETERMINISTIC pool from S so the
//                      same users return ACROSS runs               [random]
//   --rate PLANCK      override CPM (else each campaign's bid)
//   --publisher 0x     publisher for OPEN campaigns
//   --concurrency N    parallel POSTs                              [10]
//   --relay URL [http://127.0.0.1:3400]  --rpc URL  --addresses PATH
//   --dry              print the planned distribution, don't POST
import { JsonRpcProvider, getAddress, keccak256, toUtf8Bytes } from "ethers";
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

  const head = await provider.getBlockNumber();
  console.log(`\nFiring ${claims.length} claims, concurrency ${a.concurrency || 10}…`);
  // SLIM TODO: returning users need firstNonce = lastNonce+1 and prevHash =
  // previous on-chain claimHash, chained per user (and claims serialized per user
  // so each settles before the next is built). This driver still uses firstNonce=1
  // for every claim, so only each user's FIRST claim settles; reused-user
  // follow-ups are skipped as stale (reason 1) or fail PoW. The compression
  // measurement therefore needs that chaining before it's meaningful.
  console.warn("WARN: SLIM returning-user nonce/prevHash chaining not implemented — only first-per-user claims will settle. See TODO.");
  let accepted = 0, rejected = 0;
  await pool(claims, Number(a.concurrency || 10), async (c) => {
    // PoW is per (user, eventCount) when enforced; w.powTarget != null gates it.
    const tgt = c.w.powTarget != null ? await powTarget(provider, ADDR.powEngine, c.user, c.eventCount).catch(() => null) : null;
    const { envelope } = buildEnvelope({
      campaignId: c.w.cid, publisher: c.w.publisher, user: c.user, rateWei: c.w.rateWei, head,
      eventCount: c.eventCount, firstNonce: 1n,
      expectedRelaySigner: c.w.expectedRelaySigner, expectedAdvertiserRelaySigner: c.w.expectedAdvertiserRelaySigner,
      powTarget: tgt,
    });
    const { status, body } = await postClaim(relay, envelope);
    if (status === 202 && body.ok) accepted++;
    else { rejected++; if (rejected <= 5) console.log(`  POST rejected: ${status} ${JSON.stringify(body)}`); }
  });
  console.log(`Posted: ${accepted} accepted, ${rejected} rejected`);

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
