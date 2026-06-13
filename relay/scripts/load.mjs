// Multi-claim load runner. Fires N fresh users × M campaigns at the relay to
// push real settlement volume through and move the indexer's liquidity/fill
// metrics. Only loads campaigns that are GO with the relay's configured keys.
//
// Usage:
//   node scripts/load.mjs --campaigns 158,169 --users 20 [--relay URL] [--rpc URL]
// Flags:
//   --campaigns CSV   campaign ids to load              [158]
//   --users N         fresh users per campaign          [5]
//   --rate PLANCK     override CPM (else each bid)
//   --publisher 0x    publisher for OPEN campaigns
//   --concurrency N   parallel POSTs                     [10]
//   --relay URL [http://127.0.0.1:3400]  --rpc URL  --addresses PATH
import { JsonRpcProvider } from "ethers";
import { loadAddresses } from "./preflight.mjs";
import { resolveWork, runLoad } from "./lib/loadrun.mjs";

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[++i];
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const relay = (a.relay || "http://127.0.0.1:3400").replace(/\/+$/, "");
  const provider = new JsonRpcProvider(a.rpc || process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io");
  const ADDR = loadAddresses(a.addresses);
  const campaigns = (a.campaigns || "158").split(",").map((s) => BigInt(s.trim()));

  const { work, m0 } = await resolveWork({
    relay, provider, ADDR, campaigns,
    rateOverride: a.rate != null ? BigInt(a.rate) : null,
    publisherOverride: a.publisher || null,
  });
  if (!work.length) {
    console.error("No loadable campaigns. Check the relay's keys match a campaign's publisher/advertiser.");
    process.exit(1);
  }

  const { accepted, rejected, after } = await runLoad({
    relay, provider, ADDR, work, m0, usersPer: Number(a.users || 5), concurrency: Number(a.concurrency || 10),
  });

  console.log("\nRelay delta:");
  for (const k of ["claimsReceived", "claimsSubmitted", "claimsConfirmed", "claimErrors"]) {
    console.log(`  ${k.padEnd(22)} ${m0[k] ?? 0} → ${after[k] ?? 0}`);
  }
  console.log(`\nNow backfill the indexer to see the market move:\n  (cd ../indexer && node src/index.js backfill)`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
