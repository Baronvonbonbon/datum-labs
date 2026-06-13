// Register + stake a publisher on-chain (idempotent). "Register them if needed."
//
// Usage:
//   PUBLISHER_KEY=0x… node scripts/register-publisher.mjs [--take 5000] [--relay-signer 0x…]
// Flags:
//   --take BPS         take rate if not yet registered  [5000]
//   --relay-signer 0x  delegate publisherSig to a hot key (default: self-sign)
//   --rpc URL  --addresses PATH
import { JsonRpcProvider, Wallet, Contract, getAddress } from "ethers";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { send } from "./lib/tx.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const parseArgs = (a) => { const o = {}; for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) o[a[i].slice(2)] = a[++i]; return o; };

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const key = process.env.PUBLISHER_KEY;
  if (!key) { console.error("Set PUBLISHER_KEY=0x… (the publisher account)"); process.exit(2); }
  const ADDR = JSON.parse(readFileSync(resolve(ROOT, a.addresses || "../../datum/alpha-core/deployed-addresses.json"), "utf8"));
  const provider = new JsonRpcProvider(a.rpc || process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io");
  const w = new Wallet(key, provider);
  console.log(`Publisher: ${w.address}`);

  const pub = new Contract(ADDR.publishers, [
    "function isRegisteredWithRate(address) view returns (bool,uint16)",
    "function registerPublisher(uint16 takeRateBps)",
    "function relaySigner(address) view returns (address)",
    "function setRelaySigner(address signer)",
  ], w);
  const ps = new Contract(ADDR.publisherStake, [
    "function isAdequatelyStaked(address) view returns (bool)",
    "function requiredStake(address) view returns (uint256)",
    "function staked(address) view returns (uint256)",
    "function stake() payable",
  ], w);

  const [reg] = await pub.isRegisteredWithRate(w.address);
  if (!reg) await send(`registerPublisher(${a.take || 5000})`, w, pub.registerPublisher(Number(a.take || 5000)));
  else console.log("  already registered ✓");

  if (!(await ps.isAdequatelyStaked(w.address))) {
    const top = (await ps.requiredStake(w.address)) - (await ps.staked(w.address));
    await send(`stake ${top} planck`, w, ps.stake({ value: top }));
  } else console.log("  already staked ✓");

  if (a["relay-signer"]) {
    const target = getAddress(a["relay-signer"]);
    if ((await pub.relaySigner(w.address)) !== target) await send(`setRelaySigner ${target}`, w, pub.setRelaySigner(target));
    else console.log("  relaySigner already set ✓");
  }

  const [reg2, rate] = await pub.isRegisteredWithRate(w.address);
  console.log(`\n✅ ${w.address}: registered=${reg2} rate=${rate}bps staked=${await ps.isAdequatelyStaked(w.address)} relaySigner=${await pub.relaySigner(w.address)}`);
}
main().catch((e) => { console.error("FAILED:", e.message || e); process.exit(1); });
