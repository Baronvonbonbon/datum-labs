// Synthetic claim injector — posts a well-formed SignedClaimBatch to the relay's
// /claim endpoint so you can prove settlement on-chain without the browser
// extension. The relay co-signs (publisher + advertiser) and submits
// settleSignedClaims; this script just builds a valid Claim + envelope.
//
// Runs preflight first and ABORTS on NO-GO (--force to override). Claim building
// + PoW mining live in lib/claim.mjs (shared with load.mjs).
//
// Usage:
//   node scripts/inject-claim.mjs --campaign 42 --publisher 0xPUB [flags]
//
// Flags (defaults in []):
//   --relay URL          relay base URL            [http://127.0.0.1:3400]
//   --rpc URL            for the deadline head     [$RPC_URL or Paseo gateway]
//   --campaign ID        campaign id               (required)
//   --publisher 0x       claim.publisher           (required)
//   --user 0x            beneficiary               [random fresh wallet → nonce 1]
//   --rate PLANCK        ratePlanck = CPM          [campaign viewBid]
//   --events N           eventCount                [1]
//   --action N           0 view / 1 click / 2 pot  [0]
//   --nonce N            claim nonce               [1]
//   --prev 0x            previousClaimHash         [0x00..00]
//   --deadline-offset N  deadlineBlock = head + N  [1000]
//   --expected-relay 0x  expectedRelaySigner       [0x00..00 → publisher self-signs]
//   --expected-adv 0x    expectedAdvertiserRelaySigner [0x00..00 → advertiser self-signs]
//   --skip-preflight     bypass the preflight gate
//   --force              proceed despite preflight blockers
//   --dump               print the envelope, don't POST
import { ZeroHash, ZeroAddress, getAddress, JsonRpcProvider, Contract } from "ethers";
import { runPreflight, formatReport, loadAddresses } from "./preflight.mjs";
import { buildEnvelope, powTarget, postClaim, freshUser } from "./lib/claim.mjs";

const RPC_DEFAULT = process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io";

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const name = argv[i].slice(2);
    if (name === "dump" || name === "force" || name === "skip-preflight") a[name] = true;
    else a[name] = argv[++i];
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.campaign || !a.publisher) {
    console.error("required: --campaign <id> --publisher <0x>. See header for flags.");
    process.exit(2);
  }

  const relay = (a.relay || "http://127.0.0.1:3400").replace(/\/+$/, "");
  const provider = new JsonRpcProvider(a.rpc || RPC_DEFAULT);
  const ADDR = loadAddresses(a.addresses);
  const campaignId = BigInt(a.campaign);
  const publisher = getAddress(a.publisher);

  // Preflight gate — abort on NO-GO unless --force / --skip-preflight.
  if (!a.dump && !a["skip-preflight"]) {
    const pfOpts = { campaignId, publisher, rate: a.rate != null ? BigInt(a.rate) : null, provider, ADDR };
    const pf = await runPreflight(pfOpts);
    console.log(formatReport(pf, { campaignId, publisher }));
    if (pf.blockers.length && !a.force) {
      console.error(`Aborting — ${pf.blockers.length} preflight blocker(s). Re-run with --force or --skip-preflight.`);
      process.exit(1);
    }
    if (pf.blockers.length) console.warn("--force: proceeding despite blockers.\n");
    if (a.rate == null) a.rate = pf.plan.rate.toString(); // adopt the campaign bid
  }

  const user = a.user ? getAddress(a.user) : freshUser();
  const eventCount = BigInt(a.events ?? "1");
  const rateWei = BigInt(a.rate ?? "2000000000000000"); // 0.002 PAS (18-dec wei), ≥ CPM floor
  const actionType = Number(a.action ?? 0);
  const head = await provider.getBlockNumber();

  // SLIM: firstNonce = on-chain lastNonce(user, campaign, actionType) + 1. PoW +
  // both signatures bind to it, so it must match what the contract assigns at
  // settle time (a fresh user → 1, prevHash 0). Override with --nonce/--prev.
  let firstNonce = a.nonce != null ? BigInt(a.nonce) : null;
  if (firstNonce == null) {
    const settlement = new Contract(ADDR.settlement, ["function lastNonce(address,uint256,uint8) view returns (uint256)"], provider);
    firstNonce = (await settlement.lastNonce(user, campaignId, actionType)) + 1n;
  }
  const previousClaimHash = a.prev || ZeroHash;
  if (firstNonce !== 1n && !a.prev) console.warn(`warn: firstNonce=${firstNonce} with no --prev — a returning user's claimHash needs the stored prevHash, or PoW/sigs will mismatch.`);
  const target = await powTarget(provider, ADDR.powEngine, user, eventCount).catch(() => null);

  const { envelope, powTries } = buildEnvelope({
    campaignId, publisher, user, rateWei, head, eventCount,
    actionType,
    firstNonce,
    previousClaimHash,
    deadlineOffset: BigInt(a["deadline-offset"] ?? "1000"),
    expectedRelaySigner: a["expected-relay"] || ZeroAddress,
    expectedAdvertiserRelaySigner: a["expected-adv"] || ZeroAddress,
    powTarget: target,
  });
  if (target != null) console.log(`PoW enforced — mined powNonce in ${powTries} tries`);

  if (a.dump) {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }

  console.log(`→ POST ${relay}/claim  campaign=${campaignId} user=${user} firstNonce=${firstNonce} rate=${rateWei} deadline=${envelope.deadlineBlock}`);
  const { status, body } = await postClaim(relay, envelope);
  console.log(`← ${status}`, body);
  if (status >= 300) process.exit(1);
  console.log("Queued. Watch the relay's /metrics (claimBatchesSubmitted) and ../indexer for ClaimSettled.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
