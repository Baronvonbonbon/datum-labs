// HTTP surface — matches the canonical relay-bot.example contract so the SDK +
// extension interoperate unchanged:
//   GET  /metrics  /health  /events?since=N
//   POST /click    /claim
//   GET  /bulletin/<cid>  (501 — not wired in the lab relay)
// PUBLIC API surface (tunnel-exposed). Write-y config + the rich dashboard live on
// the separate LOCAL-only admin server (src/admin.mjs) and must never be here.
//   GET  /health  /metrics  /events?since=N
//   POST /click   /claim   (HMAC-gated when RELAY_HMAC_SECRET set)
import { createServer } from "node:http";
import { snapshot, eventsSince, bump, record } from "./telemetry.mjs";
import { ready } from "./provider.mjs";
import { HTTP_PORT, HTTP_BIND, RELAY_HMAC_SECRET } from "./config.mjs";
import { verify } from "./auth.mjs";
import { rateLimit } from "./ratelimit.mjs";
import { submitWithdraw, withdrawInfo } from "./withdraw.mjs";
import { policy } from "./policy.mjs";
import { log } from "./log.mjs";

const MAX_BODY = 64 * 1024; // claim envelopes carry full Claim arrays

export function startHttp({ clickBatch, claimQueue }) {
  const server = createServer((req, res) => route(req, res, { clickBatch, claimQueue }).catch((e) => json(res, 500, { error: String(e?.message ?? e) })));
  server.listen(HTTP_PORT, HTTP_BIND, () => log.info("http listening", { bind: HTTP_BIND, port: HTTP_PORT }));
  return server;
}

async function route(req, res, ctx) {
  cors(res);
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const p = url.pathname;

  if (req.method === "GET" && p === "/metrics") return json(res, 200, snapshot());
  if (req.method === "GET" && p === "/health") {
    const ok = ready;
    return json(res, ok ? 200 : 503, { ok, ...snapshot() });
  }
  if (req.method === "GET" && p === "/events") return json(res, 200, { events: eventsSince(url.searchParams.get("since") ?? "0") });
  // Approved publishers this relay co-signs for — public display metadata, no keys.
  // The webapp demo fetches this to render its publisher/site list from the relay's
  // real config instead of a hardcoded list.
  if (req.method === "GET" && p === "/relay/publishers") return json(res, 200, { publishers: policy.publishers() });

  if (req.method === "POST" && p === "/click") {
    const rl = rateLimit(req); if (!rl.ok) return tooMany(res, rl);
    const body = await readJson(req);
    if (!body.ok) return json(res, 400, { error: body.reason });
    if (!authed(req, body.raw)) return json(res, 401, { error: "unauthorized" });
    const r = ctx.clickBatch.enqueue(body.json);
    return json(res, r.ok ? 202 : 400, r);
  }
  if (req.method === "POST" && p === "/claim") {
    const rl = rateLimit(req); if (!rl.ok) return tooMany(res, rl);
    const body = await readJson(req);
    if (!body.ok) return json(res, 400, { error: body.reason });
    if (!authed(req, body.raw)) return json(res, 401, { error: "unauthorized" });
    const r = await ctx.claimQueue.enqueue(body.json);
    return json(res, r.ok ? 202 : 400, r);
  }
  // Gasless withdrawal: client posts a user-signed WithdrawAuth; relay submits
  // withdrawUserBySig, pays gas, is reimbursed the fee. HMAC-gated like /claim
  // (it spends gas). STAGED until the vault is upgraded — see src/withdraw.mjs.
  if (req.method === "GET" && p === "/withdraw-info") {
    return json(res, 200, await withdrawInfo(url.searchParams.get("user") ?? ""));
  }
  if (req.method === "POST" && p === "/withdraw") {
    const rl = rateLimit(req); if (!rl.ok) return tooMany(res, rl);
    const body = await readJson(req);
    if (!body.ok) return json(res, 400, { error: body.reason });
    if (!authed(req, body.raw)) return json(res, 401, { error: "unauthorized" });
    const r = await submitWithdraw(body.json);
    return json(res, r.ok ? 202 : 400, r);
  }
  if (req.method === "GET" && p.startsWith("/bulletin/")) {
    bump("bulletinRequests");
    record("bulletin", { cid: p.slice("/bulletin/".length) });
    return json(res, 501, { error: "bulletin-gateway-not-configured" });
  }
  json(res, 404, { error: "not-found" });
}

// Gas-spending writes require a valid HMAC when RELAY_HMAC_SECRET is set; open otherwise.
function authed(req, rawBody) {
  if (!RELAY_HMAC_SECRET) return true;
  return verify(RELAY_HMAC_SECRET, req.headers, rawBody ?? "");
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function tooMany(res, rl) {
  res.setHeader("Retry-After", String(rl.retryAfter || 60));
  return json(res, 429, { error: "rate-limited", scope: rl.scope, retryAfter: rl.retryAfter });
}
function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        resolve({ ok: false, reason: "body-too-large" });
      } else chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve({ ok: true, json: JSON.parse(raw || "{}"), raw });
      } catch {
        resolve({ ok: false, reason: "bad-json" });
      }
    });
    req.on("error", () => resolve({ ok: false, reason: "read-error" }));
  });
}
