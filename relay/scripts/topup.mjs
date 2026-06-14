// Master-EOA top-up loop (R1 decision 6a). Keeps the lab's gas-spending EOAs
// funded during a load run so the bot fleet never stalls on an empty account.
// You faucet ONE master EOA generously; this distributes PAS on demand to the
// relay signer / advertiser / admin (and any extra addresses) whenever they dip
// below --min, topping them back to --to. It will not spend the master below
// --reserve, and warns loudly when the master itself runs low — that low-master
// warning is the signal to faucet more (the "sustained-faucet strategy").
//
// ── Paseo units (post-denomination, 2026-06) ─────────────────────────────────
// pallet-revive's eth-rpc gateway is now 18-decimal wei END TO END: both
// eth_getBalance AND the tx `value` are 18-dec wei (1 PAS = 1e18). So balances,
// thresholds, AND the send value are all wei — send the wei deficit directly
// (no 1e8 scaling; the old 10-dec-planck value model was stale, like the
// create-campaign budget bug). Value is rounded DOWN to a clean 1e6-wei multiple
// (eth-rpc rejects value % 1e6 >= 500_000); confirmation uses nonce-advance
// fallback (the gateway returns null receipts for mined txs).
//
// Targets: explicit --targets wins; otherwise derived from the keys in relay/.env
// (RELAY_PRIVATE_KEY → relay signer, ADVERTISER_PRIVATE_KEY → advertiser,
// ADMIN_PRIVATE_KEY → admin). Users are NOT funded — in the dual-sig path the
// relay submits and pays gas, so users need zero PAS.
//
// Usage:
//   MASTER_PRIVATE_KEY=0x… node scripts/topup.mjs               # loop, derive targets from .env
//   node scripts/topup.mjs --once                               # single pass (pre-run funding)
//   node scripts/topup.mjs --targets 0xA,0xB --to 3 --min 1     # explicit targets
//   node scripts/topup.mjs --dry                                # show plan, send nothing
// Flags (defaults in []):
//   --master-key 0x   master EOA key (else $MASTER_PRIVATE_KEY)   (required)
//   --targets CSV     addresses to keep funded (else derived from .env keys)
//   --also CSV        extra addresses to add to the derived set
//   --min DOT         top up a target when its balance drops below this   [0.5]
//   --to DOT          balance to top a target back up to                  [2.0]
//   --reserve DOT     never spend the master below this                   [1.0]
//   --interval SEC    seconds between cycles (ignored with --once)        [60]
//   --once            single pass then exit
//   --dry             print the plan; send nothing
//   --rpc URL
import { JsonRpcProvider, Wallet, parseUnits, formatUnits, getAddress } from "ethers";
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { confirm } from "./lib/tx.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(ROOT, ".env") });

// Paseo eth-rpc (post-denomination): balances AND tx value are 18-dec wei.
const STEP = 1_000_000n; // round value down to a clean 1e6-wei multiple (eth-rpc rejects value % 1e6 >= 500_000)
const wei = (d) => parseUnits(String(d), 18); // PAS → wei (balances / thresholds / tx value)
const dotFromWei = (w) => formatUnits(w, 18);
const roundStep = (w) => w - (w % STEP);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const name = argv[i].slice(2);
    if (name === "once" || name === "dry") a[name] = true;
    else a[name] = argv[++i];
  }
  return a;
}

// Resolve the target set: explicit --targets, else derive from the .env keys.
function resolveTargets(a) {
  const out = new Map(); // addr -> role label
  const add = (addr, role) => {
    if (!addr) return;
    const c = getAddress(addr);
    if (!out.has(c)) out.set(c, role);
  };
  if (a.targets) {
    for (const t of a.targets.split(",")) add(t.trim(), "target");
  } else {
    const fromKey = (k) => {
      const key = (process.env[k] || "").trim();
      const ZERO = "0x" + "0".repeat(64);
      return key && key !== ZERO ? new Wallet(key).address : null;
    };
    add(fromKey("RELAY_PRIVATE_KEY"), "relay-signer");
    add(fromKey("ADVERTISER_PRIVATE_KEY"), "advertiser");
    add(fromKey("ADMIN_PRIVATE_KEY"), "admin");
  }
  if (a.also) for (const t of a.also.split(",")) add(t.trim(), "extra");
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const provider = new JsonRpcProvider(a.rpc || process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io");

  const masterKey = (a["master-key"] || process.env.MASTER_PRIVATE_KEY || "").trim();
  if (!masterKey) {
    console.error("Set MASTER_PRIVATE_KEY (the faucet-funded EOA) in relay/.env or pass --master-key.");
    process.exit(2);
  }
  const master = new Wallet(masterKey, provider);

  const targets = resolveTargets(a);
  targets.delete(master.address); // never top up self
  if (!targets.size) {
    console.error("No targets. Pass --targets 0x..,0x.. or set RELAY/ADVERTISER/ADMIN keys in relay/.env.");
    process.exit(1);
  }

  const minWei = wei(a.min || "0.5");
  const toWei = wei(a.to || "2.0");
  const reserveWei = wei(a.reserve || "1.0");
  if (toWei <= minWei) {
    console.error(`--to (${a.to || 2.0}) must exceed --min (${a.min || 0.5}).`);
    process.exit(2);
  }

  console.log(`Master ${master.address}`);
  console.log(`Targets (${targets.size}): ${[...targets].map(([ad, r]) => `${r}=${ad}`).join("  ")}`);
  console.log(`Policy: top up to ${a.to || 2.0} DOT when below ${a.min || 0.5}; keep master ≥ ${a.reserve || 1.0}${a.dry ? "  [DRY RUN]" : ""}\n`);

  let totalSent = 0n;
  let nonce = null;

  async function cycle() {
    let masterWei = await provider.getBalance(master.address);
    nonce = await provider.getTransactionCount(master.address, "pending");
    const ts = new Date().toISOString().slice(11, 19);
    let sent = 0n, funded = 0;

    for (const [addr, role] of targets) {
      const balWei = await provider.getBalance(addr).catch(() => null);
      if (balWei == null) {
        console.log(`  [${ts}] ${role} ${addr}: balance read failed, skip`);
        continue;
      }
      if (balWei >= minWei) continue; // healthy

      // Tx value is 18-dec wei → send the wei deficit directly, rounded down to
      // a clean 1e6-wei multiple.
      const valueWei = roundStep(toWei - balWei) || STEP;

      // --dry is a pure plan view: show intended sends regardless of master balance.
      if (a.dry) {
        console.log(`  [${ts}] would send ${dotFromWei(valueWei)} PAS → ${role} ${addr} (bal ${dotFromWei(balWei)})`);
        sent += valueWei;
        continue;
      }

      if (masterWei - valueWei < reserveWei) {
        console.warn(
          `  [${ts}] ⚠ master LOW: ${dotFromWei(masterWei)} PAS — can't fund ${role} (${addr}) ` +
            `without dropping below reserve ${a.reserve || 1.0}. FAUCET THE MASTER.`,
        );
        break;
      }

      try {
        const tx = await master.sendTransaction({ to: addr, value: valueWei, nonce: nonce++ });
        const c = await confirm(provider, tx, master.address);
        if (c.status === 0) {
          console.error(`  [${ts}] ✗ topup reverted ${role} ${addr} (${tx.hash})`);
        } else {
          masterWei -= valueWei;
          sent += valueWei;
          totalSent += valueWei;
          funded++;
          console.log(`  [${ts}] +${dotFromWei(valueWei)} PAS → ${role} ${addr}  (was ${dotFromWei(balWei)}) ${c.source === "receipt" ? "✓" : `(${c.source})`}`);
        }
      } catch (e) {
        console.error(`  [${ts}] ✗ send failed ${role} ${addr}: ${String(e?.message ?? e).slice(0, 120)}`);
        return; // bail this cycle; re-sync nonce next time
      }
    }

    if (funded || a.dry) {
      console.log(`  [${ts}] cycle: funded ${funded}, sent ${dotFromWei(sent)} PAS, master ${dotFromWei(masterWei)} DOT, total this run ${dotFromWei(totalSent)} PAS`);
    }
  }

  await cycle();
  if (a.once || a.dry) return;

  const interval = Number(a.interval || 60) * 1000;
  console.log(`\nLooping every ${a.interval || 60}s. Ctrl-C to stop.`);
  process.on("SIGINT", () => {
    console.log(`\nStopped. Total sent this run: ${dotFromWei(totalSent)} PAS.`);
    process.exit(0);
  });
  for (;;) {
    await sleep(interval);
    await cycle().catch((e) => console.error("cycle error (will retry):", e.message));
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
