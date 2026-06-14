// One-shot liquidity-curve scenario: create K fresh campaigns, spin up the relay,
// drive N users/campaign of real settlements, then show how the whole-market
// indexer metrics moved. Turnkey — manages the relay child process itself.
//
// Keys (relay/.env): ADVERTISER_PRIVATE_KEY (creator), ADMIN_PRIVATE_KEY (activator),
// RELAY_PRIVATE_KEY (publisher's relay signer — also the load's on-chain sender).
//
// Usage:
//   node scripts/scenario.mjs --campaigns 3 --users 5 [flags]
// Flags (defaults in []):
//   --campaigns K   how many NEW campaigns to create   [3]
//   --users N       fresh users per campaign           [5]
//   --budget DOT    escrow per campaign                 [0.5]
//   --bid PLANCK    view CPM                            [2000000000]
//   --publisher 0x  bound publisher (relay must hold its signer) [diana]
//   --port N        relay port to spin up               [3410]
//   --no-index      skip the indexer before/after snapshot
//   --rpc URL  --addresses PATH
import { JsonRpcProvider, Wallet, parseUnits, getAddress } from "ethers";
import { config } from "dotenv";
import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { createAndActivate } from "./lib/campaign.mjs";
import { resolveWork, runLoad } from "./lib/loadrun.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEXER = resolve(ROOT, "../indexer");
config({ path: resolve(ROOT, ".env") });

const DIANA = "0xcA5668fB864Acab0aC7f4CFa73949174720b58D0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseArgs = (argv) => { const a = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] == null ? true : argv[++i]; return a; };

// Run the indexer in its own process (its own deps/DB). Returns the summary object or null.
function indexerSummary() {
  if (!existsSync(INDEXER)) return null;
  const r = spawnSync("node", ["-e", "import('./src/metrics.js').then(M=>console.log(JSON.stringify(M.summary())))"], { cwd: INDEXER, encoding: "utf8" });
  try { return JSON.parse(r.stdout.trim().split("\n").pop()); } catch { return null; }
}
function indexerBackfill() {
  if (!existsSync(INDEXER)) return;
  spawnSync("node", ["src/index.js", "backfill"], { cwd: INDEXER, stdio: "ignore" });
}

async function waitHealth(url, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${url}/health`)).ok) return true; } catch {}
    await sleep(500);
  }
  return false;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const ADDR = JSON.parse(readFileSync(resolve(ROOT, a.addresses || "../../datum/alpha-core/deployed-addresses.json"), "utf8"));
  const provider = new JsonRpcProvider(a.rpc || process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io");
  const advKey = process.env.ADVERTISER_PRIVATE_KEY, adminKey = process.env.ADMIN_PRIVATE_KEY;
  if (!advKey || !adminKey) { console.error("Set ADVERTISER_PRIVATE_KEY + ADMIN_PRIVATE_KEY in relay/.env"); process.exit(2); }
  const advertiser = new Wallet(advKey, provider), admin = new Wallet(adminKey, provider);

  const K = Number(a.campaigns || 3), users = Number(a.users || 5);
  const publisher = getAddress(a.publisher || DIANA);
  const budget = parseUnits(String(a.budget || "0.5"), 18), bid = BigInt(a.bid || "2000000000000000"); // 18-dec wei; bid 0.002 PAS ≥ floor
  const port = Number(a.port || 3410), relay = `http://127.0.0.1:${port}`;
  const doIndex = !a["no-index"];

  console.log(`\n══ SCENARIO: ${K} campaigns × ${users} users ══`);
  const before = doIndex ? indexerSummary() : null;

  // 1. Create + activate K campaigns.
  console.log(`\n▸ Creating ${K} campaigns (publisher=${publisher}, advertiser=${advertiser.address})…`);
  const cids = [];
  for (let i = 0; i < K; i++) {
    const { cid, active } = await createAndActivate({ ADDR, advertiser, admin, publisher, budgetPlanck: budget, dailyCapPlanck: budget, bidPlanck: bid });
    if (active) { cids.push(cid); console.log(`  ✓ campaign ${cid} active`); }
    else console.log(`  ✗ campaign ${cid} failed to activate`);
  }
  if (!cids.length) { console.error("No campaigns created."); process.exit(1); }

  // 2. Spin up the relay child.
  console.log(`\n▸ Starting relay on :${port}…`);
  const child = spawn("node", ["src/index.mjs"], { cwd: ROOT, env: { ...process.env, HTTP_PORT: String(port), CLAIM_BATCH_SIZE: "1", CLAIM_BATCH_MAX_AGE_MS: "3000", LOG_LEVEL: "0" }, stdio: "ignore" });
  let result;
  try {
    if (!(await waitHealth(relay))) throw new Error("relay did not become healthy");

    // 3. Drive load across the new campaigns.
    console.log(`\n▸ Driving load…`);
    const { work, m0 } = await resolveWork({ relay, provider, ADDR, campaigns: cids });
    if (!work.length) throw new Error("no loadable campaigns (relay key mismatch?)");
    result = await runLoad({ relay, provider, ADDR, work, m0, usersPer: users });
    console.log(`  ${result.accepted} accepted, ${result.rejected} rejected`);
  } finally {
    child.kill("SIGTERM");
    await sleep(500);
  }

  // 4. Indexer before/after.
  if (doIndex) {
    console.log(`\n▸ Backfilling indexer…`);
    indexerBackfill();
    const after = indexerSummary();
    if (before && after) {
      console.log(`\n══ MARKET DELTA ══`);
      const rows = [["campaigns", "campaigns"], ["activeCampaigns", "activeCampaigns"], ["publishers", "publishers"], ["settlements", "settlements"], ["uniqueUsers", "uniqueUsers"], ["impressions", "impressions"], ["settledDot", "settledDot"], ["liquidityRatio", "liquidityRatio"], ["settlementSuccessRate", "settlementSuccessRate"]];
      for (const [label, k] of rows) console.log(`  ${label.padEnd(22)} ${fmt(before[k])} → ${fmt(after[k])}`);
    }
  }
  console.log(`\nDone. New campaigns: ${cids.join(", ")}`);
}

const fmt = (v) => (typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(4)) : v ?? "—");

main().catch((e) => { console.error("\nFAILED:", e.message || e); process.exit(1); });
