// Config loader. Resolves RPC, contract addresses, and indexing knobs from
// .env (optional) with defaults that point at the sibling datum/alpha-core deploy.
// Live addresses are resolved from the on-chain registry (env-first) via
// resolveWatched(); the seed file is the per-slot fallback.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAddresses } from "./registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function abs(p) {
  return resolve(ROOT, p);
}

export const RPC_URL = process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io";
export const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 2000);
export const BACKFILL_DEPTH = Number(process.env.BACKFILL_DEPTH || 200000);
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 12000);
export const DB_PATH = abs(process.env.DB_PATH || "data/datum.db");
export const PORT = Number(process.env.PORT || 4319);
export const START_BLOCK = process.env.START_BLOCK || "auto"; // "auto" | number

export const ADDR_FILE = abs(process.env.DATUM_ADDRESSES || "../../datum/alpha-core/deployed-addresses.json");

let _addresses;
export function addresses() {
  if (_addresses) return _addresses;
  try {
    _addresses = JSON.parse(readFileSync(ADDR_FILE, "utf8"));
  } catch (e) {
    throw new Error(
      `Could not read contract addresses at ${ADDR_FILE}. ` +
        `Set DATUM_ADDRESSES in .env to your deployed-addresses.json.\n${e.message}`,
    );
  }
  return _addresses;
}

// The contracts whose events drive the network-effect metrics.
// (settlement proxy emits ClaimSettled/ClaimRejected even though logic lives
//  in the A/B delegates — delegatecall preserves the emitting address.)
// REQUIRED: the original four (supply/demand/settlement core).
// OPTIONAL (R1.3): paymentVault (value conservation + payouts) and the emission
//  orchestration (emissionEngine/mintCoordinator). Included when the address file
//  has them; absent on older deploys, in which case those tables stay empty.
const REQUIRED = ["settlement", "clickRegistry", "campaigns", "publishers"];
const OPTIONAL = ["paymentVault", "emissionEngine", "mintCoordinator"];

function pickWatched(a, { source, routerAddress } = {}) {
  const missing = REQUIRED.filter((k) => !a[k]);
  if (missing.length) {
    throw new Error(
      `Missing contract address(es): ${missing.join(", ")}` +
        (source ? ` (source=${source}, router=${routerAddress ?? "none"})` : ""),
    );
  }
  const out = {};
  for (const k of [...REQUIRED, ...OPTIONAL]) {
    if (a[k]) out[k] = a[k].toLowerCase();
  }
  return out;
}

// Cached resolved watch-set (address -> contract-name map is derived from this).
let _watched = null;

// Resolve the watched contracts from the on-chain registry (env-first, seed-file
// fallback). Call once at startup, then watchedContracts() returns the cache.
export async function resolveWatched(provider) {
  const { addresses: a, source, routerAddress } = await resolveAddresses({ provider, addrFile: ADDR_FILE });
  _watched = pickWatched(a, { source, routerAddress });
  return _watched;
}

// Returns the resolved watch-set when resolveWatched() has run, else falls back
// to the static seed file (so callers that import before resolution still work).
export function watchedContracts() {
  if (_watched) return _watched;
  return pickWatched(addresses());
}
