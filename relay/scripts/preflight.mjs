// Settlement preflight — read-only. Checks every on-chain prerequisite for a
// dual-sig settlement of (campaign, publisher) BEFORE you spend gas, so the
// first real attempt doesn't fail on a guessable revert (E81–E85, E27, …).
//
// Importable: `runPreflight(...)` returns { results, blockers, plan }.
// CLI:  node scripts/preflight.mjs --campaign <ID> --publisher <0xPUB> [flags]
import { JsonRpcProvider, Contract, getAddress, ZeroAddress, formatUnits } from "ethers";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATUS = ["Pending", "Active", "Paused", "Completed", "Terminated", "Expired"];
const PLANCK = 10n ** 10n;
const dot = (p) => formatUnits(p ?? 0n, 10);
export const PASS = "PASS", WARN = "WARN", FAIL = "FAIL", INFO = "INFO";

const ABIS = {
  publishers: [
    "function isRegisteredWithRate(address) view returns (bool,uint16)",
    "function approved(address) view returns (bool)",
    "function relaySigner(address) view returns (address)",
  ],
  publisherStake: [
    "function isAdequatelyStaked(address) view returns (bool)",
    "function requiredStake(address) view returns (uint256)",
    "function staked(address) view returns (uint256)",
  ],
  advertiserStake: ["function isAdequatelyStaked(address) view returns (bool)"],
  campaigns: [
    "function getCampaignForSettlement(uint256) view returns (uint8,address,uint16)",
    "function getCampaignAdvertiser(uint256) view returns (address)",
    "function getAdvertiserRelaySigner(address) view returns (address)",
    "function getCampaignViewBid(uint256) view returns (uint256)",
    "function getCampaignRequiresZkProof(uint256) view returns (bool)",
    "function getCampaignMinStake(uint256) view returns (uint256)",
    "function minUserSettledHistory(uint256) view returns (uint32)",
    "function getCampaignPublisher(uint256) view returns (address)",
    "function minimumCpmFloor() view returns (uint256)",
  ],
  pauseRegistry: ["function pausedSettlement() view returns (bool)", "function paused() view returns (bool)"],
  settlement: ["function maxBatchSize() view returns (uint256)"],
};

const tryGet = async (fn, fb = null) => {
  try {
    return await fn();
  } catch {
    return fb;
  }
};

export function loadAddresses(path) {
  return JSON.parse(readFileSync(resolve(ROOT, path || "../../datum/alpha-core/deployed-addresses.json"), "utf8"));
}

// Core check. Returns { results:[{level,label,detail}], blockers:[...], plan:{...} }.
export async function runPreflight({ campaignId, publisher, rate, relaySignerArg = null, advSignerArg = null, provider, ADDR }) {
  const results = [];
  const add = (level, label, detail) => results.push({ level, label, detail });
  const C = (k) => new Contract(ADDR[k], ABIS[k], provider);
  const pub = C("publishers"), pstake = C("publisherStake"), camp = C("campaigns"), pause = C("pauseRegistry"), settle = C("settlement");

  const pausedSettlement = await tryGet(() => pause.pausedSettlement());
  const pausedAll = await tryGet(() => pause.paused());
  add(pausedSettlement === false && pausedAll === false ? PASS : pausedSettlement === null ? WARN : FAIL,
    "Settlement not paused", `pausedSettlement=${pausedSettlement} paused=${pausedAll}`);

  const cfs = await tryGet(() => camp.getCampaignForSettlement(campaignId));
  if (!cfs) add(FAIL, "Campaign exists", `getCampaignForSettlement(${campaignId}) reverted`);
  else {
    const [status, , takeRate] = cfs;
    add(Number(status) === 1 ? PASS : FAIL, "Campaign Active", `status=${STATUS[Number(status)] ?? status}, takeRate=${takeRate}bps`);
    const boundPub = await tryGet(() => camp.getCampaignPublisher(campaignId), ZeroAddress);
    if (boundPub === ZeroAddress) add(PASS, "Publisher binding", "open campaign (any publisher)");
    else add(getAddress(boundPub) === publisher ? PASS : FAIL, "Publisher binding", `campaign bound to ${boundPub}`);
  }

  const reg = await tryGet(() => pub.isRegisteredWithRate(publisher));
  add(reg && reg[0] ? PASS : FAIL, "Publisher registered", reg ? `registered=${reg[0]}, rate=${reg[1]}bps` : "call reverted");
  const approved = await tryGet(() => pub.approved(publisher));
  add(approved === true ? PASS : INFO, "Publisher approved", `approved=${approved} (only blocks when whitelist mode on)`);
  const adq = await tryGet(() => pstake.isAdequatelyStaked(publisher));
  const stk = await tryGet(() => pstake.staked(publisher), 0n);
  const req = await tryGet(() => pstake.requiredStake(publisher), 0n);
  add(adq === true ? PASS : adq === false ? FAIL : WARN, "Publisher staked", `staked=${dot(stk)} / required=${dot(req)} PAS`);
  const minStake = await tryGet(() => camp.getCampaignMinStake(campaignId), 0n);
  if (minStake > 0n) add(stk >= minStake ? PASS : FAIL, "Campaign min-stake", `requires ${dot(minStake)} PAS, has ${dot(stk)}`);

  const relaySigner = await tryGet(() => pub.relaySigner(publisher), ZeroAddress);
  let pubSigPath;
  if (relaySigner === ZeroAddress) {
    pubSigPath = { mode: "self-sign", keyMustBe: publisher, expectedRelay: ZeroAddress };
    add(PASS, "publisherSig path", `relaySigner unset → SELF-SIGN: relay key must be the publisher (${publisher})`);
  } else {
    pubSigPath = { mode: "relay-signer", keyMustBe: getAddress(relaySigner), expectedRelay: getAddress(relaySigner) };
    const ok = !relaySignerArg || relaySignerArg === getAddress(relaySigner);
    add(ok ? PASS : FAIL, "publisherSig path", `relaySigner=${relaySigner} → relay key must be this addr`);
  }

  const advertiser = await tryGet(() => camp.getCampaignAdvertiser(campaignId), ZeroAddress);
  const advRelay = advertiser !== ZeroAddress ? await tryGet(() => camp.getAdvertiserRelaySigner(advertiser), ZeroAddress) : ZeroAddress;
  let advSigPath = null;
  if (advertiser === ZeroAddress) add(FAIL, "advertiserSig path", "campaign has no advertiser");
  else if (advRelay === ZeroAddress) {
    advSigPath = { mode: "self-sign", keyMustBe: getAddress(advertiser), expectedAdv: ZeroAddress };
    add(PASS, "advertiserSig path", `no advertiser relay signer → SELF-SIGN: advertiser key must be ${advertiser}`);
  } else {
    advSigPath = { mode: "relay-signer", keyMustBe: getAddress(advRelay), expectedAdv: getAddress(advRelay) };
    const ok = !advSignerArg || advSignerArg === getAddress(advRelay);
    add(ok ? PASS : FAIL, "advertiserSig path", `advertiserRelaySigner=${advRelay} → adv key must be this addr`);
  }
  if (ADDR.advertiserStake && advertiser !== ZeroAddress) {
    const advAdq = await tryGet(() => C("advertiserStake").isAdequatelyStaked(advertiser));
    add(advAdq === false ? WARN : INFO, "Advertiser staked", `isAdequatelyStaked=${advAdq} (enforced at create; informational)`);
  }

  const viewBid = await tryGet(() => camp.getCampaignViewBid(campaignId), 0n);
  const floor = await tryGet(() => camp.minimumCpmFloor(), 0n);
  const effRate = rate != null ? BigInt(rate) : viewBid;
  add(effRate >= floor ? PASS : FAIL, "Rate ≥ CPM floor", `rate(CPM)=${dot(effRate)} floor=${dot(floor)} bid=${dot(viewBid)} PAS`);
  if (viewBid > 0n && effRate > viewBid) add(WARN, "Rate ≤ campaign bid", `rate ${dot(effRate)} > bid ${dot(viewBid)} — advertiser may refuse`);

  const zk = await tryGet(() => camp.getCampaignRequiresZkProof(campaignId));
  add(zk === false ? PASS : zk === true ? FAIL : WARN, "No ZK required", `requiresZkProof=${zk} (empty proof → reject 16 if true)`);
  const minHist = await tryGet(() => camp.minUserSettledHistory(campaignId), 0n);
  add(Number(minHist) === 0 ? PASS : WARN, "No user-history gate", `minUserSettledHistory=${minHist} (fresh user has 0 → reject 28 if >0)`);

  if (pubSigPath) {
    const bal = await tryGet(() => provider.getBalance(pubSigPath.keyMustBe), 0n);
    add(bal >= PLANCK / 10n ? PASS : WARN, "Relay key funded", `${pubSigPath.keyMustBe} has ${dot(bal)} PAS for gas`);
  }
  add(INFO, "maxBatchSize", String(await tryGet(() => settle.maxBatchSize(), "?")));

  const blockers = results.filter((r) => r.level === FAIL);
  return { results, blockers, plan: { rate: effRate, pubSigPath, advSigPath, viewBid, floor } };
}

export function formatReport({ results, blockers, plan }, { campaignId, publisher }) {
  const ICON = { PASS: "✓", WARN: "⚠", FAIL: "✗", INFO: "·" };
  const lines = [`\nPreflight — campaign ${campaignId}, publisher ${publisher}\n`];
  for (const r of results) lines.push(`  ${ICON[r.level]} ${r.level.padEnd(4)} ${r.label.padEnd(24)} ${r.detail}`);
  lines.push("");
  if (blockers.length) {
    lines.push(`NO-GO — ${blockers.length} blocker(s):`);
    for (const b of blockers) lines.push(`   ✗ ${b.label}: ${b.detail}`);
  } else {
    const { pubSigPath: p, advSigPath: ad, rate } = plan;
    lines.push("GO — no blockers. Required key setup:");
    if (p) lines.push(`   RELAY_PRIVATE_KEY      = key for ${p.keyMustBe}  (${p.mode})`);
    if (ad) lines.push(`   ADVERTISER_PRIVATE_KEY = key for ${ad.keyMustBe}  (${ad.mode})`);
    lines.push(`\n   node scripts/inject-claim.mjs --campaign ${campaignId} --publisher ${publisher} \\`);
    lines.push(`        --rate ${rate} --expected-relay ${p?.expectedRelay ?? ZeroAddress} --expected-adv ${ad?.expectedAdv ?? ZeroAddress}`);
  }
  return lines.join("\n") + "\n";
}

// ── CLI ──
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[++i];
  return a;
}
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.campaign || !a.publisher) {
    console.error("required: --campaign <id> --publisher <0x>");
    process.exit(2);
  }
  const ADDR = loadAddresses(a.addresses);
  const provider = new JsonRpcProvider(a.rpc || process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io");
  const opts = {
    campaignId: BigInt(a.campaign),
    publisher: getAddress(a.publisher),
    rate: a.rate != null ? BigInt(a.rate) : null,
    relaySignerArg: a["relay-signer"] ? getAddress(a["relay-signer"]) : null,
    advSignerArg: a["advertiser-signer"] ? getAddress(a["advertiser-signer"]) : null,
    provider,
    ADDR,
  };
  const out = await runPreflight(opts);
  console.log(formatReport(out, opts));
  process.exit(out.blockers.length ? 1 : 0);
}
