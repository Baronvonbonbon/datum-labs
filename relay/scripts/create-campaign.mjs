// Campaign creation tooling — stands up a fresh, ACTIVE campaign end-to-end so
// the lab can generate its own demand instead of only settling seeded campaigns.
//
// Flow (mirrors DatumCampaigns.createCampaign + admin activation):
//   1. ensure the advertiser is adequately staked (advertiserStake.stake)
//   2. createCampaign{value: budget}(publisher, [pot], [], false, 0, 0, 0)  → Pending
//   3. admin activates via governanceRouter.adminActivateCampaign(cid)       → Active
//
// Keys (from relay/.env or env):
//   ADVERTISER_PRIVATE_KEY  creates + funds the campaign (also co-signs at settle time)
//   ADMIN_PRIVATE_KEY       the AdminGovernance governor (Alice/deployer) — activates
//
// Usage:
//   node scripts/create-campaign.mjs --publisher 0xPUB [flags]
// Flags (defaults in []):
//   --publisher 0x   bound publisher (must be registered)   [diana 0xca56…]
//   --budget PAS     campaign escrow (18-dec wei on-chain)    [0.5]
//   --bid WEI        view CPM (rateWei, ≥ 1e15 floor)         [2000000000000000 = 0.002 PAS]
//   --daily-cap DOT  per-pot daily cap                        [= budget]
//   --rpc URL  --addresses PATH
import { JsonRpcProvider, Wallet, parseUnits, getAddress } from "ethers";
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createAndActivate } from "./lib/campaign.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(ROOT, ".env") });

const DIANA = "0xcA5668fB864Acab0aC7f4CFa73949174720b58D0";
const dotToWei = (d) => parseUnits(String(d), 18); // PAS → 18-dec wei (post-denomination; contract uses *Wei)

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[++i];
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const ADDR = JSON.parse(readFileSync(resolve(ROOT, a.addresses || "../../datum/alpha-core/deployed-addresses.json"), "utf8"));
  const provider = new JsonRpcProvider(a.rpc || process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io");

  const advKey = process.env.ADVERTISER_PRIVATE_KEY;
  const adminKey = process.env.ADMIN_PRIVATE_KEY;
  if (!advKey || !adminKey) {
    console.error("Set ADVERTISER_PRIVATE_KEY (creator) and ADMIN_PRIVATE_KEY (AdminGovernance governor) in relay/.env");
    process.exit(2);
  }
  const advertiser = new Wallet(advKey, provider);
  const admin = new Wallet(adminKey, provider);

  const publisher = getAddress(a.publisher || DIANA);
  const budget = dotToWei(a.budget || "0.5");
  const dailyCap = a["daily-cap"] ? dotToWei(a["daily-cap"]) : budget;
  const bid = BigInt(a.bid || "2000000000000000"); // 0.002 PAS CPM (18-dec wei, ≥ 1e15 floor)

  console.log(`Creating campaign: advertiser=${advertiser.address} publisher=${publisher}`);
  console.log(`  budget=${a.budget || "0.5"} PAS  bidCPM=${bid} wei  dailyCap=${dailyCap}\n`);

  const { cid, active } = await createAndActivate({ ADDR, advertiser, admin, publisher, budgetPlanck: budget, dailyCapPlanck: dailyCap, bidPlanck: bid });

  console.log(`\n${active ? "✅" : "❌"} Campaign ${cid} ${active ? "Active" : "NOT active"} publisher=${publisher}`);
  if (active) {
    console.log(`\nSettle it (the relay must hold this publisher's relay-signer key + the advertiser key):`);
    console.log(`  node scripts/inject-claim.mjs --campaign ${cid} --publisher ${publisher}`);
    console.log(`  node scripts/load.mjs --campaigns ${cid} --users 5`);
  }
}

main().catch((e) => {
  console.error("\nFAILED:", e.message || e);
  process.exit(1);
});
