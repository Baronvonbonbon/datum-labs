// sign-withdraw.mjs — build + sign a DatumPaymentVault WithdrawAuth and POST it to
// the relay's /withdraw, so you can test gasless withdrawal without the extension
// (the extension produces this signature in production). The signing key never
// pays gas; the relay submits + is reimbursed maxFee.
//
// STAGED: needs a DatumPaymentVault deployed with withdrawUserBySig.
//
// Usage:
//   node scripts/sign-withdraw.mjs --user-key 0x... [flags]
// Flags (defaults in []):
//   --relay URL        relay base URL                 [http://127.0.0.1:3400]
//   --user-key 0x      the balance owner's key (signs; pays NO gas)  (required)
//   --recipient 0x     net destination                [0x0 → the user]
//   --max-fee PLANCK   max fee the user authorizes     [1000000000 = 0.1 DOT]
//   --deadline-blocks N  valid for N more blocks       [5000]
//   --dump             print the signed payload, don't POST
import { JsonRpcProvider, Wallet, getAddress, ZeroAddress } from "ethers";
import { WITHDRAW_AUTH_TYPES } from "../src/abis.mjs";

const RPC_DEFAULT = process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io";

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const n = argv[i].slice(2);
    if (n === "dump") a[n] = true;
    else a[n] = argv[++i];
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a["user-key"]) {
    console.error("required: --user-key 0x<balance owner key>. See header for flags.");
    process.exit(2);
  }
  const relay = (a.relay || "http://127.0.0.1:3400").replace(/\/+$/, "");
  const provider = new JsonRpcProvider(a.rpc || RPC_DEFAULT);
  const user = new Wallet(a["user-key"], provider);
  const recipient = a.recipient ? getAddress(a.recipient) : ZeroAddress;
  const maxFee = BigInt(a["max-fee"] ?? "1000000000");

  // Pull the on-chain nonce + domain the relay reports.
  const info = await (await fetch(`${relay}/withdraw-info?user=${user.address}`)).json();
  if (!info.ok) {
    console.error("withdraw-info failed:", info.reason);
    process.exit(1);
  }
  const { chainId } = await provider.getNetwork();
  const deadline = BigInt((await provider.getBlockNumber()) + Number(a["deadline-blocks"] ?? 5000));

  const domain = { name: "DatumPaymentVault", version: "1", chainId, verifyingContract: info.vault };
  const value = { user: user.address, recipient, maxFee, nonce: BigInt(info.nonce), deadline };
  const sig = await user.signTypedData(domain, WITHDRAW_AUTH_TYPES, value);

  const payload = { user: user.address, recipient, maxFee: maxFee.toString(), deadline: deadline.toString(), sig };
  console.log(`user ${user.address}  balance ${info.userBalancePlanck} planck  nonce ${info.nonce}`);
  console.log(`authorizing: net→${recipient === ZeroAddress ? "self" : recipient}, maxFee ${maxFee} planck, deadline block ${deadline}`);

  if (a.dump) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const res = await fetch(`${relay}/withdraw`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  console.log(`← ${res.status}`, await res.json().catch(() => ({})));
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
