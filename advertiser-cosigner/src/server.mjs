// Independent advertiser co-signer. Exposes POST /cosign: given a batch envelope
// the publisher relay assembled, the advertiser INDEPENDENTLY decides whether to
// sign (it owns the campaign + the rate is within policy) and returns advertiserSig,
// or refuses. This is the half of dual-sig the all-in-one lab relay collapsed.
import "dotenv/config";
import { createServer } from "node:http";
import { JsonRpcProvider, Wallet, Contract, getAddress, ZeroAddress } from "ethers";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAddresses } from "./registry.mjs";
import { computeClaimsHash, signClaimBatch } from "./cosign.mjs";
import { verify } from "./auth.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io";
const PORT = Number(process.env.HTTP_PORT || 3411);
const BIND = process.env.HTTP_BIND || "127.0.0.1";
const ALLOWLIST = (process.env.CAMPAIGN_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_CPM = BigInt(process.env.MAX_CPM_PLANCK || "0");
const COSIGN_SECRET = (process.env.COSIGN_SECRET || "").trim(); // must match relay's ADVERTISER_COSIGNER_SECRET
// Seed-file fallback path; live addresses resolve from the chain registry below.
const ADDR_FILE = resolve(ROOT, process.env.DATUM_ADDRESSES || "../../datum/alpha-core/deployed-addresses.json");

const key = process.env.ADVERTISER_PRIVATE_KEY;
if (!key || /^0x0+$/.test(key)) { console.error("Set ADVERTISER_PRIVATE_KEY"); process.exit(2); }

const provider = new JsonRpcProvider(RPC);
const wallet = new Wallet(key, provider);

// Resolve canonical addresses from the on-chain registry (env-first, seed-file
// fallback). Self-contained in production: set DATUM_GOVERNANCE_ROUTER + RPC_URL.
const { addresses: ADDR, routerAddress, source } = await resolveAddresses({ provider, addrFile: ADDR_FILE });
for (const k of ["campaigns", "dualSig"]) {
  if (!ADDR[k]) { console.error(`address missing: ${k} (source=${source}, router=${routerAddress ?? "none"})`); process.exit(2); }
}

const campaigns = new Contract(ADDR.campaigns, [
  "function getCampaignAdvertiser(uint256) view returns (address)",
  "function getAdvertiserRelaySigner(address) view returns (address)",
  "function getCampaignViewBid(uint256) view returns (uint256)",
], provider);

let chainId = null;
const metrics = { cosignRequests: 0, cosigned: 0, refused: 0, errors: 0 };
const advCache = new Map(); // campaignId -> advertiser

async function advertiserOf(cid) {
  if (advCache.has(cid)) return advCache.get(cid);
  const a = await campaigns.getCampaignAdvertiser(cid);
  advCache.set(cid, a);
  return a;
}

// Decide + sign. Returns { ok, advertiserSig?, reason? }.
async function cosign(body) {
  if (!body || body.user == null || body.campaignId == null || !Array.isArray(body.claims) || !body.claims.length) {
    return { ok: false, reason: "malformed" };
  }
  const cid = BigInt(body.campaignId);
  if (ALLOWLIST.length && !ALLOWLIST.includes(cid.toString())) return { ok: false, reason: "campaign-not-allowed" };

  // Independent ownership check — only sign for campaigns this key advertises.
  const advertiser = await advertiserOf(cid).catch(() => ZeroAddress);
  const expectedAdvRelay = await campaigns.getAdvertiserRelaySigner(advertiser).catch(() => ZeroAddress);
  const mustBe = expectedAdvRelay !== ZeroAddress ? expectedAdvRelay : advertiser;
  if (getAddress(mustBe) !== wallet.address) {
    return { ok: false, reason: `not-my-campaign (advertiser=${advertiser}, expected signer=${mustBe}, I am ${wallet.address})` };
  }

  // Independent rate policy — refuse claims priced above the advertiser's cap.
  if (MAX_CPM > 0n) {
    for (const c of body.claims) if (BigInt(c.ratePlanck ?? 0) > MAX_CPM) return { ok: false, reason: "rate-exceeds-policy" };
  }

  // Recompute the digest ourselves — never trust a caller-supplied claimsHash.
  const claimsHash = computeClaimsHash(body.claims.map((c) => c.claimHash));
  const value = {
    user: getAddress(body.user),
    campaignId: cid,
    claimsHash,
    deadlineBlock: BigInt(body.deadlineBlock),
    expectedRelaySigner: body.expectedRelaySigner ? getAddress(body.expectedRelaySigner) : ZeroAddress,
    expectedAdvertiserRelaySigner: body.expectedAdvertiserRelaySigner ? getAddress(body.expectedAdvertiserRelaySigner) : ZeroAddress,
  };
  const advertiserSig = await signClaimBatch(wallet, chainId, ADDR.dualSig, value);
  return { ok: true, advertiserSig, signer: wallet.address };
}

function send(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(b);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method === "GET" && url.pathname === "/health") return send(res, chainId ? 200 : 503, { ok: !!chainId, signer: wallet.address, chainId });
  if (req.method === "GET" && url.pathname === "/metrics") return send(res, 200, { ...metrics, signer: wallet.address, chainId });
  if (req.method === "POST" && url.pathname === "/cosign") {
    metrics.cosignRequests++;
    let body = "";
    for await (const c of req) body += c;
    if (COSIGN_SECRET && !verify(COSIGN_SECRET, req.headers, body)) { metrics.refused++; return send(res, 401, { ok: false, reason: "unauthorized" }); }
    let parsed;
    try { parsed = JSON.parse(body || "{}"); } catch { metrics.errors++; return send(res, 400, { ok: false, reason: "bad-json" }); }
    try {
      const r = await cosign(parsed);
      if (r.ok) { metrics.cosigned++; return send(res, 200, r); }
      metrics.refused++;
      console.log(`refused campaign=${parsed.campaignId}: ${r.reason}`);
      return send(res, 403, r);
    } catch (e) {
      metrics.errors++;
      return send(res, 500, { ok: false, reason: String(e?.message ?? e) });
    }
  }
  send(res, 404, { error: "not-found" });
});

const net = await provider.getNetwork();
chainId = Number(net.chainId);
server.listen(PORT, BIND, () => {
  console.log(`advertiser co-signer → http://${BIND}:${PORT}`);
  console.log(`  signer (advertiser): ${wallet.address}  chainId: ${chainId}  dualSig: ${ADDR.dualSig}`);
  console.log(`  addresses: ${source === "router" ? `router ${routerAddress}` : "static seed file"}`);
  console.log(`  policy: allowlist=${ALLOWLIST.length ? ALLOWLIST.join(",") : "any-of-mine"} maxCPM=${MAX_CPM}`);
});
