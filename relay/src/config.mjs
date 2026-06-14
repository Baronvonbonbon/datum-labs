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

// A1 / dual-sig independence gate. RELAY_PUBLIC=1 declares this relay is (or will
// be) reachable beyond loopback. ALLOW_INSECURE_SELF_COSIGN=1 is an explicit,
// auditable acknowledgement that the operator is running the "self-cosign" mode
// (relay holds the advertiser key and signs BOTH sides), which DISABLES dual-sig
// refutation — permitted only for a trusted single-operator dev/lab run.
const flag = (v) => /^(1|true|yes)$/i.test((v || "").trim());
export const RELAY_PUBLIC = flag(process.env.RELAY_PUBLIC);
export const ALLOW_INSECURE_SELF_COSIGN = flag(process.env.ALLOW_INSECURE_SELF_COSIGN);

// Rate limiting for the gas-spending POST endpoints (/claim, /click, /withdraw).
// Caps griefing/gas-drain from the public tunnel. Loopback (the operator's own
// load/inject scripts) is exempt. Sliding window per client IP (Cloudflare's
// cf-connecting-ip when tunnelled) + a global cap that bounds total relay gas
// burn regardless of source. 0 disables a limit.
export const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
export const RATE_LIMIT_PER_IP = Number(process.env.RATE_LIMIT_PER_IP || 30);   // per window per IP
export const RATE_LIMIT_GLOBAL = Number(process.env.RATE_LIMIT_GLOBAL || 300);  // per window, all IPs

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

// Loopback binds where a self-cosign relay is reachable only by the local
// operator. 0.0.0.0 binds all interfaces → treated as exposed, not loopback.
const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost"]);

export function assertConfig() {
  const ZERO = "0x" + "0".repeat(64);
  if (!RELAY_PRIVATE_KEY || RELAY_PRIVATE_KEY === ZERO) {
    throw new Error("RELAY_PRIVATE_KEY is required (and must be the publisher's registered relay signer).");
  }

  // ── A1 independence gate ─────────────────────────────────────────────────
  // "self-cosign" = the relay holds the advertiser key (ADVERTISER_PRIVATE_KEY)
  // AND no independent advertiser co-signer is configured, so the relay would
  // produce BOTH the publisher and advertiser signatures itself. That collapses
  // dual-sig refutation: there is no independent party who can withhold a sig.
  const hasAdvKey = !!ADVERTISER_PRIVATE_KEY && ADVERTISER_PRIVATE_KEY !== ZERO;
  const hasCosigner = !!ADVERTISER_COSIGNER_URL || Object.keys(ADVERTISER_COSIGNERS).length > 0;
  const selfCosign = hasAdvKey && !hasCosigner;

  if (selfCosign) {
    const exposed = RELAY_PUBLIC || !LOOPBACK_BINDS.has(HTTP_BIND);
    if (exposed && !ALLOW_INSECURE_SELF_COSIGN) {
      throw new Error(
        "REFUSING TO START: self-cosign mode is active (relay holds ADVERTISER_PRIVATE_KEY and " +
        "would sign BOTH the publisher and advertiser sides), which defeats dual-sig refutation — " +
        "one operator controls both signatures. This is forbidden on a relay reachable beyond " +
        `loopback (HTTP_BIND=${HTTP_BIND}, RELAY_PUBLIC=${RELAY_PUBLIC}).\n` +
        "Fix: run an independent advertiser co-signer and set ADVERTISER_COSIGNER_URL (or " +
        "ADVERTISER_COSIGNERS) and UNSET ADVERTISER_PRIVATE_KEY. For a trusted single-operator " +
        "dev/lab run only, set ALLOW_INSECURE_SELF_COSIGN=1 to explicitly acknowledge the risk."
      );
    }
    // Permitted (loopback dev, or explicit override): make the loss of the
    // refutation guarantee impossible to miss.
    console.warn(
      "\x1b[33m[SECURITY] self-cosign mode ACTIVE — the relay holds the advertiser key and signs " +
      "BOTH sides; dual-sig refutation is DISABLED (no independent party can refuse). " +
      (ALLOW_INSECURE_SELF_COSIGN ? "Permitted via ALLOW_INSECURE_SELF_COSIGN." : "Permitted only because bound to loopback.") +
      " Do NOT use for production value.\x1b[0m"
    );
  }
}
