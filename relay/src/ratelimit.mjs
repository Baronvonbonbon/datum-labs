// Sliding-window rate limiter for the gas-spending POST endpoints. Two layers:
//   • per client IP  — stops one source from flooding co-sign/submit (gas burn);
//   • global         — hard cap on total accepted writes per window, so the
//                      relay's gas spend is bounded no matter how many IPs.
// Loopback is exempt: the operator's own inject/load/scenario scripts hit the
// relay from 127.0.0.1 and must never be throttled. When tunnelled, the real
// client IP is Cloudflare's `cf-connecting-ip` (the socket is the local tunnel).
import { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_PER_IP, RATE_LIMIT_GLOBAL } from "./config.mjs";
import { bump } from "./telemetry.mjs";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

const ipHits = new Map(); // ip -> { count, reset }
let glob = { count: 0, reset: 0 };

export function clientIp(req) {
  const h = req.headers || {};
  const cf = h["cf-connecting-ip"];
  if (cf) return String(cf).trim();
  const xff = h["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// Returns { ok } or { ok:false, scope, retryAfter }. Counts a hit only when
// allowed. Loopback + disabled-limit (0) short-circuit to allowed.
export function rateLimit(req) {
  const ip = clientIp(req);
  if (LOOPBACK.has(ip)) return { ok: true };
  const now = Date.now();

  if (RATE_LIMIT_GLOBAL > 0) {
    if (now > glob.reset) glob = { count: 0, reset: now + RATE_LIMIT_WINDOW_MS };
    if (glob.count >= RATE_LIMIT_GLOBAL) { bump("rateLimited"); return { ok: false, scope: "global", retryAfter: Math.max(1, Math.ceil((glob.reset - now) / 1000)) }; }
  }

  let e;
  if (RATE_LIMIT_PER_IP > 0) {
    e = ipHits.get(ip);
    if (!e || now > e.reset) { e = { count: 0, reset: now + RATE_LIMIT_WINDOW_MS }; ipHits.set(ip, e); }
    if (e.count >= RATE_LIMIT_PER_IP) { bump("rateLimited"); return { ok: false, scope: "ip", retryAfter: Math.max(1, Math.ceil((e.reset - now) / 1000)) }; }
  }

  if (e) e.count++;
  if (RATE_LIMIT_GLOBAL > 0) glob.count++;
  return { ok: true };
}

// Drop expired per-IP buckets so the Map can't grow unbounded under churn.
export function startRateLimitGc() {
  const t = setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of ipHits) if (now > e.reset) ipHits.delete(ip);
  }, Math.max(30000, RATE_LIMIT_WINDOW_MS));
  t.unref();
  return t;
}
