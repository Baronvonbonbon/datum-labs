// Aggregated operator status for the dashboard: live metrics + signer balance +
// policy + co-signer reachability + recent events. Powers GET /api/status.
import { provider, relayWallet, chainId } from "./provider.mjs";
import { snapshot, eventsSince } from "./telemetry.mjs";
import { policySummary } from "./policy.mjs";
import { ADVERTISER_COSIGNER_URL, RELAY_HMAC_SECRET } from "./config.mjs";

const startedAt = Date.now();
let bal = { planck: null, t: 0 };
let cos = { v: null, t: 0 };

export async function buildStatus() {
  // Balance + co-signer health are cached so dashboard polling stays cheap.
  if (Date.now() - bal.t > 10000) {
    const v = await provider.getBalance(relayWallet.address).catch(() => null);
    bal = { planck: v == null ? null : v.toString(), t: Date.now() };
  }
  if (ADVERTISER_COSIGNER_URL && Date.now() - cos.t > 5000) {
    try {
      const r = await fetch(ADVERTISER_COSIGNER_URL.replace(/\/+$/, "") + "/metrics", { signal: AbortSignal.timeout(2500) });
      cos = { v: { url: ADVERTISER_COSIGNER_URL, reachable: r.ok, metrics: r.ok ? await r.json() : null }, t: Date.now() };
    } catch {
      cos = { v: { url: ADVERTISER_COSIGNER_URL, reachable: false, metrics: null }, t: Date.now() };
    }
  }

  return {
    relay: { signer: relayWallet.address, chainId, uptimeMs: Date.now() - startedAt, balanceWei: bal.planck },
    metrics: snapshot(),
    policy: policySummary(),
    auth: { enabled: !!RELAY_HMAC_SECRET },
    cosigner: ADVERTISER_COSIGNER_URL ? cos.v : null,
    events: eventsSince(0).slice(-40).reverse(),
    ts: Date.now(),
  };
}
