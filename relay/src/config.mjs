import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const abs = (p) => resolve(ROOT, p);

export const RPC_URL = process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io";
export const RELAY_PRIVATE_KEY = (process.env.RELAY_PRIVATE_KEY || "").trim();
export const ADVERTISER_PRIVATE_KEY = (process.env.ADVERTISER_PRIVATE_KEY || "").trim();
// Independent advertiser co-signer endpoint. When set (and no ADVERTISER_PRIVATE_KEY),
// the relay fetches advertiserSig over HTTP instead of holding the advertiser key —
// the real dual-sig topology (publisher + advertiser as separate parties).
export const ADVERTISER_COSIGNER_URL = (process.env.ADVERTISER_COSIGNER_URL || "").trim();
// Interim per-advertiser co-signer routing. JSON map keyed by advertiser address:
//   { "<addr>": { "url": "<base url>", "secret": "<cosign hmac>" } }   (object form)
//   { "<addr>": "<base url>" }                                          (uses ADVERTISER_COSIGNER_SECRET)
// The relay resolves getCampaignAdvertiser(id) and routes the /cosign call to the
// matching entry, falling back to ADVERTISER_COSIGNER_URL. Bridge until the on-chain
// advertiser profileHash → endpoint registry lands (then discovered, not configured).
export const ADVERTISER_COSIGNERS = (() => {
  try {
    const m = JSON.parse(process.env.ADVERTISER_COSIGNERS || "{}");
    const out = {};
    for (const k of Object.keys(m)) {
      const v = m[k];
      out[k.toLowerCase()] = typeof v === "string"
        ? { url: v.trim(), secret: "" }
        : { url: String(v.url || "").trim(), secret: String(v.secret || "").trim() };
    }
    return out;
  } catch { return {}; }
})();
// HMAC shared secrets (controlled-exposure gate). RELAY_HMAC_SECRET protects inbound
// /claim + /click; ADVERTISER_COSIGNER_SECRET signs the outbound /cosign call (must
// match the co-signer's COSIGN_SECRET). Unset = endpoint open (localhost only).
export const RELAY_HMAC_SECRET = (process.env.RELAY_HMAC_SECRET || "").trim();
export const ADVERTISER_COSIGNER_SECRET = (process.env.ADVERTISER_COSIGNER_SECRET || "").trim();
export const HTTP_PORT = Number(process.env.HTTP_PORT || 3400);
export const HTTP_BIND = process.env.HTTP_BIND || "127.0.0.1";
export const CLICK_BATCH_SIZE = Number(process.env.CLICK_BATCH_SIZE || 25);
export const CLICK_BATCH_MAX_AGE_MS = Number(process.env.CLICK_BATCH_MAX_AGE_MS || 15000);
export const CLAIM_BATCH_SIZE = Number(process.env.CLAIM_BATCH_SIZE || 1); // batches per tx (Paseo dual-sig cap ≈ 1)
export const CLAIM_BATCH_MAX_AGE_MS = Number(process.env.CLAIM_BATCH_MAX_AGE_MS || 15000);
// Option-1 pipelining: how many settlement txs may be in flight (unconfirmed)
// at once from the single relay signer, and how long before a stuck tx is resubmitted.
export const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT || 25);
export const SETTLE_STUCK_MS = Number(process.env.SETTLE_STUCK_MS || 30000);
export const LOG_LEVEL = Number(process.env.LOG_LEVEL || 1);

export const CAMPAIGN_ALLOWLIST = (process.env.CAMPAIGN_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => BigInt(s));

// Seed file used as the per-slot fallback when the on-chain registry can't be
// reached or hasn't registered a slot. Live resolution (env-first) happens in
// registry.mjs; in production set DATUM_GOVERNANCE_ROUTER + RPC_URL and this
// file becomes optional. Override with DATUM_ADDRESSES.
export const ADDR_FILE = abs(process.env.DATUM_ADDRESSES || "../../datum/alpha-core/deployed-addresses.json");

let _addr;
// Static seed read (sync). Prefer resolveAddresses() in registry.mjs — it reads
// the live router and falls back to this. Kept for callers that only need the
// static seed (e.g. one-shot scripts).
export function addresses() {
  if (_addr) return _addr;
  try {
    _addr = JSON.parse(readFileSync(ADDR_FILE, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read addresses at ${ADDR_FILE} — set DATUM_ADDRESSES.\n${e.message}`);
  }
  for (const k of ["dualSig", "clickRegistry", "publishers", "campaigns"]) {
    if (!_addr[k]) throw new Error(`addresses missing key: ${k}`);
  }
  return _addr;
}

export function assertConfig() {
  const ZERO = "0x" + "0".repeat(64);
  if (!RELAY_PRIVATE_KEY || RELAY_PRIVATE_KEY === ZERO) {
    throw new Error("RELAY_PRIVATE_KEY is required (and must be the publisher's registered relay signer).");
  }
}
