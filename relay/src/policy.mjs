// Operator policy — what this relay co-signs/submits for, AND how (auto vs manual
// signing). Loaded from relay.config.json (RELAY_CONFIG overrides path); the live
// in-memory copy is the source of truth, so admin mutations take effect immediately
// (hot, no restart) and are persisted back to disk.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CAMPAIGN_ALLOWLIST } from "./config.mjs";
import { log } from "./log.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const cfg = {
  publishers: new Set(), // publishers this relay co-signs for (lowercased)
  campaigns: new Set(), // accepted campaign ids (string)
  maxCpmWei: 0n, // 0 = no cap
  signing: { mode: "auto", manualCampaigns: new Set() }, // auto | manual; per-campaign manual override
  source: "defaults (open)",
  path: null,
};

export function loadPolicy() {
  const path = process.env.RELAY_CONFIG || resolve(ROOT, "relay.config.json");
  cfg.path = path;
  if (existsSync(path)) {
    try {
      const j = JSON.parse(readFileSync(path, "utf8"));
      cfg.publishers = new Set((j.publishers || []).map((a) => String(a).toLowerCase()));
      cfg.campaigns = new Set((j.campaigns || []).map(String));
      cfg.maxCpmWei = BigInt(j.policy?.maxCpmWei || "0");
      cfg.signing.mode = j.signing?.mode === "manual" ? "manual" : "auto";
      cfg.signing.manualCampaigns = new Set((j.signing?.manualCampaigns || []).map(String));
      cfg.source = path;
    } catch (e) {
      log.warn("bad relay.config.json — ignoring", { err: String(e?.message ?? e) });
    }
  }
  for (const c of CAMPAIGN_ALLOWLIST) cfg.campaigns.add(c.toString());
  log.info("policy loaded", { publishers: cfg.publishers.size || "any", campaigns: cfg.campaigns.size || "any", signing: cfg.signing.mode });
  return cfg;
}

function persist() {
  if (!cfg.path) return;
  const out = {
    publishers: [...cfg.publishers],
    campaigns: [...cfg.campaigns],
    policy: { maxCpmWei: cfg.maxCpmWei.toString() },
    signing: { mode: cfg.signing.mode, manualCampaigns: [...cfg.signing.manualCampaigns] },
  };
  writeFileSync(cfg.path, JSON.stringify(out, null, 2) + "\n");
  log.info("policy persisted", { path: cfg.path });
}

// ── accept gate (called from the queues) ──
export function acceptClaim(campaignId, publisher, rateWei) {
  if (cfg.campaigns.size && !cfg.campaigns.has(String(campaignId))) return { ok: false, reason: "campaign-not-accepted" };
  if (cfg.publishers.size && publisher && !cfg.publishers.has(String(publisher).toLowerCase())) return { ok: false, reason: "publisher-not-accepted" };
  if (cfg.maxCpmWei > 0n && rateWei != null) {
    try {
      if (BigInt(rateWei) > cfg.maxCpmWei) return { ok: false, reason: "rate-exceeds-policy" };
    } catch {}
  }
  return { ok: true };
}

// "auto" → co-sign + submit immediately; "manual" → hold for operator approval.
export function signingModeFor(campaignId) {
  if (cfg.signing.mode === "manual") return "manual";
  return cfg.signing.manualCampaigns.has(String(campaignId)) ? "manual" : "auto";
}

// ── admin mutations (local-only callers) ──
export const policy = {
  addPublisher(a) { cfg.publishers.add(String(a).toLowerCase()); persist(); },
  removePublisher(a) { cfg.publishers.delete(String(a).toLowerCase()); persist(); },
  addCampaign(id) { cfg.campaigns.add(String(id)); persist(); },
  removeCampaign(id) { cfg.campaigns.delete(String(id)); persist(); },
  setMaxCpm(v) { cfg.maxCpmWei = BigInt(v || "0"); persist(); },
  setSigningMode(mode) { cfg.signing.mode = mode === "manual" ? "manual" : "auto"; persist(); },
  setCampaignManual(id, manual) { if (manual) cfg.signing.manualCampaigns.add(String(id)); else cfg.signing.manualCampaigns.delete(String(id)); persist(); },
  // Replace the whole config from a raw JSON string (advanced editor). Validates.
  setRaw(jsonStr) {
    const j = JSON.parse(jsonStr); // throws on bad JSON → caller returns 400
    cfg.publishers = new Set((j.publishers || []).map((a) => String(a).toLowerCase()));
    cfg.campaigns = new Set((j.campaigns || []).map(String));
    cfg.maxCpmWei = BigInt(j.policy?.maxCpmWei || "0");
    cfg.signing.mode = j.signing?.mode === "manual" ? "manual" : "auto";
    cfg.signing.manualCampaigns = new Set((j.signing?.manualCampaigns || []).map(String));
    persist();
  },
  raw() {
    return JSON.stringify({
      publishers: [...cfg.publishers],
      campaigns: [...cfg.campaigns],
      policy: { maxCpmWei: cfg.maxCpmWei.toString() },
      signing: { mode: cfg.signing.mode, manualCampaigns: [...cfg.signing.manualCampaigns] },
    }, null, 2);
  },
  path() { return cfg.path; },
};

export function policySummary() {
  return {
    source: cfg.source,
    path: cfg.path,
    publishers: [...cfg.publishers],
    campaigns: [...cfg.campaigns],
    maxCpmWei: cfg.maxCpmWei.toString(),
    openPublishers: cfg.publishers.size === 0,
    openCampaigns: cfg.campaigns.size === 0,
    signing: { mode: cfg.signing.mode, manualCampaigns: [...cfg.signing.manualCampaigns] },
  };
}
