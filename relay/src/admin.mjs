// LOCAL-ONLY operator console + control plane. Binds 127.0.0.1 (ADMIN_BIND) on
// ADMIN_PORT — never tunnel-exposed. Serves the dashboard and the write endpoints
// the public API must never carry: policy edits (publishers/campaigns/rate),
// signing-mode, the manual-approval queue, and raw-config editing.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { policy, policySummary } from "./policy.mjs";
import { buildStatus } from "./status.mjs";

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 3420);
const ADMIN_BIND = process.env.ADMIN_BIND || "127.0.0.1";

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(s);
}
async function readBody(req) {
  let b = "";
  for await (const c of req) b += c;
  try { return JSON.parse(b || "{}"); } catch { return null; }
}

export function startAdmin({ claimQueue, log }) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${ADMIN_PORT}`);
      const p = url.pathname;

      // ── read ──
      if (req.method === "GET" && (p === "/" || p === "/dashboard")) {
        try { res.writeHead(200, { "content-type": "text/html" }); return res.end(await readFile(resolve(PUBLIC, "dashboard.html"))); }
        catch { return json(res, 404, { error: "dashboard not found" }); }
      }
      if (req.method === "GET" && p === "/api/status") {
        const s = await buildStatus();
        s.pendingApproval = claimQueue.listPending();
        return json(res, 200, s);
      }
      if (req.method === "GET" && p === "/api/config") return json(res, 200, { path: policy.path(), raw: policy.raw() });

      // ── write (policy) ──
      if (req.method === "POST") {
        const body = await readBody(req);
        if (body == null) return json(res, 400, { error: "bad-json" });
        switch (p) {
          case "/api/policy/publisher":
            body.action === "remove" ? policy.removePublisher(body.address) : policy.addPublisher(body.address);
            return json(res, 200, { ok: true, policy: policySummary() });
          case "/api/policy/campaign":
            body.action === "remove" ? policy.removeCampaign(body.id) : policy.addCampaign(body.id);
            return json(res, 200, { ok: true, policy: policySummary() });
          case "/api/policy/maxcpm":
            policy.setMaxCpm(body.value ?? "0");
            return json(res, 200, { ok: true, policy: policySummary() });
          case "/api/signing/mode":
            policy.setSigningMode(body.mode);
            return json(res, 200, { ok: true, policy: policySummary() });
          case "/api/signing/campaign":
            policy.setCampaignManual(body.id, !!body.manual);
            return json(res, 200, { ok: true, policy: policySummary() });
          case "/api/config":
            try { policy.setRaw(body.raw); } catch (e) { return json(res, 400, { error: "invalid config: " + (e?.message ?? e) }); }
            return json(res, 200, { ok: true, policy: policySummary() });
          case "/api/approve":
            return json(res, 200, await claimQueue.approve(body.id));
          case "/api/reject":
            return json(res, 200, claimQueue.reject(body.id));
        }
      }
      json(res, 404, { error: "not-found" });
    } catch (e) {
      json(res, 500, { error: String(e?.message ?? e) });
    }
  });
  server.listen(ADMIN_PORT, ADMIN_BIND, () => log.info("admin console", { url: `http://${ADMIN_BIND}:${ADMIN_PORT}`, note: "local-only" }));
  return server;
}
