// DATUM fleet monitor (RELAY-TOOLKIT-SCOPE §3). One small service that watches the
// whole single-host deployment and makes outages VISIBLE:
//   • each relay  /health     → up? error-rate delta, queue/inflight backlog
//   • each cosigner /health   → up? (a down cosigner means dual-sig can't complete)
//   • the chain               → block height advancing (RPC liveness)
//   • submitter gas balances  → low-gas before the relay stalls on empty
// It exposes its own /health + Prometheus /metrics (single scrape target for the
// fleet) and fires STATE-CHANGE alerts (FIRING on a new issue, RESOLVED when it
// clears) to the log + an optional generic JSON webhook ({text} — Slack/ntfy/
// Discord-slack compatible). Read-only: it never holds keys.
//
// Config (env or flags). Defaults match the live diana/frank + bob/charlie layout.
//   RELAYS        "name=url,…"   [diana=http://127.0.0.1:3400,frank=http://127.0.0.1:3410]
//   COSIGNERS     "name=url,…"   [bob=http://127.0.0.1:3402,charlie=http://127.0.0.1:3411]
//   GAS_WATCH     "name=addr,…"  [diana=0xcA56…,frank=0x9262…]  (submitters that pay gas)
//   RPC_URL                       [Paseo gateway]
//   MIN_GAS_PAS                   low-gas alert threshold (PAS)  [50]
//   QUEUE_BACKLOG                 queued-claims alert threshold  [100]
//   CHAIN_STALL_CYCLES            cycles of no new block → alert [5]
//   MONITOR_PORT / MONITOR_BIND   [3500 / 127.0.0.1]
//   MONITOR_INTERVAL              seconds between cycles         [30]
//   ALERT_WEBHOOK                 optional JSON-{text} webhook URL
//   ALERT_HEARTBEAT_MIN           re-send still-firing issues every N min (0=off) [0]
// Run: node scripts/monitor.mjs    (or as the datum-monitor.service unit)
import { JsonRpcProvider, formatEther } from "ethers";
import { createServer } from "node:http";
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(ROOT, ".env") });

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : (process.env[n.toUpperCase().replace(/-/g, "_")] ?? d); };
const parseMap = (s) => new Map((s || "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => { const [k, ...v] = p.split("="); return [k, v.join("=")]; }));

const RELAYS = parseMap(flag("relays", "diana=http://127.0.0.1:3400,frank=http://127.0.0.1:3410"));
const COSIGNERS = parseMap(flag("cosigners", "bob=http://127.0.0.1:3402,charlie=http://127.0.0.1:3411"));
const GAS_WATCH = parseMap(flag("gas-watch", "diana=0xcA5668fB864Acab0aC7f4CFa73949174720b58D0,frank=0x92622970Bd48dD26c53bCCd09Aa6a0245dbc7620"));
const RPC_URL = flag("rpc", process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io");
const MIN_GAS = Number(flag("min-gas-pas", "50"));
const QUEUE_BACKLOG = Number(flag("queue-backlog", "100"));
const CHAIN_STALL_CYCLES = Number(flag("chain-stall-cycles", "5"));
const PORT = Number(flag("monitor-port", "3500"));
const BIND = flag("monitor-bind", "127.0.0.1");
const INTERVAL = Number(flag("monitor-interval", "30")) * 1000;
const WEBHOOK = (flag("alert-webhook", "") || "").trim();
// "ntfy" (plain body + Title/Priority/Tags headers) or "json" ({text,title,level}).
// Auto-detected for ntfy.sh URLs; override with ALERT_WEBHOOK_FORMAT.
const WEBHOOK_FORMAT = (flag("alert-webhook-format", "") || (/ntfy/i.test(WEBHOOK) ? "ntfy" : "json")).toLowerCase();
const HEARTBEAT_MIN = Number(flag("alert-heartbeat-min", "0"));

const provider = new JsonRpcProvider(RPC_URL);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Live state surfaced on /metrics + /health.
const state = {
  ts: 0, chainBlock: 0, monitorUp: true,
  relays: {},    // name -> { up, claimsConfirmed, claimErrors, queued, inflight }
  cosigners: {}, // name -> { up, chainId }
  gas: {},       // name -> { pas }
};
const issues = new Map();   // key -> { since, lastNotified }  (active issues)
let lastBlock = 0, stallCycles = 0, prevErrors = {};

async function getJson(url, ms = 5000) {
  const ctl = AbortSignal.timeout(ms);
  const r = await fetch(url, { signal: ctl });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function alert(level, key, text) {
  log(`ALERT[${level}] ${key}: ${text}`);
  if (!WEBHOOK) return;
  try {
    const opts = WEBHOOK_FORMAT === "ntfy"
      ? { // ntfy.sh: message in the body, metadata in headers (zero-signup push)
          headers: {
            "Title": `DATUM ${level}: ${key}`,
            "Priority": level === "FIRING" ? "high" : "default",
            "Tags": level === "FIRING" ? "rotating_light" : "white_check_mark",
          },
          body: text,
        }
      : { // generic JSON sink (Slack / Discord-slack / custom)
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: `[DATUM ${level}] ${key}: ${text}`, title: key, level }),
        };
    await fetch(WEBHOOK, { method: "POST", ...opts, signal: AbortSignal.timeout(5000) });
  } catch (e) { log("webhook failed:", String(e?.message ?? e).slice(0, 80)); }
}

// Reconcile the current issue set against the active set → FIRING / RESOLVED edges.
async function reconcileIssues(current) {
  const now = Date.now();
  for (const [key, text] of current) {
    const ex = issues.get(key);
    if (!ex) { issues.set(key, { since: now, lastNotified: now }); await alert("FIRING", key, text); }
    else if (HEARTBEAT_MIN > 0 && now - ex.lastNotified >= HEARTBEAT_MIN * 60000) { ex.lastNotified = now; await alert("FIRING", key, text + " (still firing)"); }
  }
  for (const key of [...issues.keys()]) {
    if (!current.has(key)) { issues.delete(key); await alert("RESOLVED", key, "cleared"); }
  }
}

async function cycle() {
  const current = new Map(); // key -> text (issues seen this cycle)

  // Relays
  for (const [name, url] of RELAYS) {
    try {
      const h = await getJson(url.replace(/\/+$/, "") + "/health");
      state.relays[name] = { up: !!h.ok, claimsConfirmed: h.claimsConfirmed ?? 0, claimErrors: h.claimErrors ?? 0, queued: h.queued ?? 0, inflight: h.inflight ?? 0 };
      if (!h.ok) current.set(`relay.${name}.unhealthy`, `relay ${name} reports not-ready`);
      if ((h.queued ?? 0) > QUEUE_BACKLOG) current.set(`relay.${name}.backlog`, `relay ${name} queue backlog ${h.queued} > ${QUEUE_BACKLOG}`);
      const dErr = (h.claimErrors ?? 0) - (prevErrors[name] ?? h.claimErrors ?? 0);
      if (dErr >= 10) current.set(`relay.${name}.errors`, `relay ${name} +${dErr} claimErrors since last cycle`);
      prevErrors[name] = h.claimErrors ?? 0;
    } catch (e) {
      state.relays[name] = { up: false };
      current.set(`relay.${name}.down`, `relay ${name} unreachable (${String(e?.message ?? e).slice(0, 40)})`);
    }
  }

  // Cosigners (down = dual-sig can't complete → settlements stall)
  for (const [name, url] of COSIGNERS) {
    try {
      const h = await getJson(url.replace(/\/+$/, "") + "/health");
      state.cosigners[name] = { up: !!h.ok, chainId: h.chainId ?? null };
      if (!h.ok) current.set(`cosigner.${name}.unhealthy`, `cosigner ${name} not-ready`);
    } catch (e) {
      state.cosigners[name] = { up: false };
      current.set(`cosigner.${name}.down`, `cosigner ${name} unreachable — dual-sig will stall`);
    }
  }

  // Chain liveness
  try {
    const blk = await provider.getBlockNumber();
    state.chainBlock = blk;
    if (blk > lastBlock) { lastBlock = blk; stallCycles = 0; }
    else { stallCycles++; if (stallCycles >= CHAIN_STALL_CYCLES) current.set("chain.stalled", `chain block ${blk} unchanged for ${stallCycles} cycles`); }
  } catch (e) { current.set("chain.rpc", `RPC unreachable (${String(e?.message ?? e).slice(0, 40)})`); }

  // Submitter gas
  for (const [name, addr] of GAS_WATCH) {
    try {
      const pas = Number(formatEther(await provider.getBalance(addr)));
      state.gas[name] = { pas };
      if (pas < MIN_GAS) current.set(`gas.${name}.low`, `submitter ${name} gas ${pas.toFixed(2)} PAS < ${MIN_GAS} — TOP UP`);
    } catch { state.gas[name] = { pas: null }; }
  }

  state.ts = Date.now();
  await reconcileIssues(current);
}

// Prometheus text exposition for the whole fleet.
function prometheus() {
  const L = [];
  L.push(`datum_monitor_up 1`);
  L.push(`datum_monitor_active_issues ${issues.size}`);
  L.push(`datum_chain_block ${state.chainBlock}`);
  for (const [n, r] of Object.entries(state.relays)) {
    L.push(`datum_relay_up{instance="${n}"} ${r.up ? 1 : 0}`);
    if (r.up) {
      L.push(`datum_relay_claims_confirmed{instance="${n}"} ${r.claimsConfirmed}`);
      L.push(`datum_relay_claim_errors{instance="${n}"} ${r.claimErrors}`);
      L.push(`datum_relay_queued{instance="${n}"} ${r.queued}`);
      L.push(`datum_relay_inflight{instance="${n}"} ${r.inflight}`);
    }
  }
  for (const [n, c] of Object.entries(state.cosigners)) L.push(`datum_cosigner_up{instance="${n}"} ${c.up ? 1 : 0}`);
  for (const [n, g] of Object.entries(state.gas)) if (g.pas != null) L.push(`datum_submitter_gas_pas{instance="${n}"} ${g.pas}`);
  return L.join("\n") + "\n";
}

createServer((req, res) => {
  if (req.url === "/metrics") { res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }); return res.end(prometheus()); }
  if (req.url === "/health") {
    const healthy = state.monitorUp && issues.size === 0;
    res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: healthy, issues: [...issues.keys()], ...state }, null, 2));
  }
  res.writeHead(404).end();
}).listen(PORT, BIND, () => log(`monitor → http://${BIND}:${PORT}  (/metrics /health)`));

log(`watching relays=[${[...RELAYS.keys()]}] cosigners=[${[...COSIGNERS.keys()]}] gasWatch=[${[...GAS_WATCH.keys()]}] minGas=${MIN_GAS}PAS interval=${INTERVAL / 1000}s webhook=${WEBHOOK ? "set" : "none"}`);
await cycle().catch((e) => log("cycle error:", e.message));
setInterval(() => cycle().catch((e) => log("cycle error:", e.message)), INTERVAL);
