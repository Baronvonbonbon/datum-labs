// Bulletin creative loader — backs GET /bulletin/<cid>.
//
// The Publisher SDK's Bulletin Chain creative loader fetches a campaign's IPFS
// creative from `${relay}/bulletin/<cid>`. This proxies the content from the
// relay's configured IPFS gateway (default: the local Kubo gateway), passing the
// upstream content-type through so the SDK can tell JSON metadata from an
// HTML/SVG creative. Read-only, content-addressed (immutable), size-capped, and
// CID-validated so it can't be turned into an open proxy or path-traversal.
import { IPFS_GATEWAY } from "./config.mjs";

// CIDv0 (base58btc, "Qm" + 44 chars) or CIDv1 (multibase base32, "b" + base32).
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;
const MAX_BYTES = 512 * 1024; // creatives are small; cap to avoid proxying blobs
const TIMEOUT_MS = 8000;

// Returns { status, contentType, body } for a 200, or { status, json } otherwise.
export async function fetchBulletin(cid) {
  if (!CID_RE.test(cid)) return { status: 400, json: { error: "bad-cid" } };

  let upstream;
  try {
    upstream = await fetch(`${IPFS_GATEWAY}/${cid}`, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    return { status: timedOut ? 504 : 502, json: { error: timedOut ? "ipfs-timeout" : "ipfs-unreachable" } };
  }

  if (!upstream.ok) {
    return { status: upstream.status === 404 ? 404 : 502, json: { error: "ipfs-" + upstream.status } };
  }

  const declared = Number(upstream.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) return { status: 413, json: { error: "creative-too-large" } };

  const body = Buffer.from(await upstream.arrayBuffer());
  if (body.length > MAX_BYTES) return { status: 413, json: { error: "creative-too-large" } };

  return {
    status: 200,
    contentType: upstream.headers.get("content-type") || "application/octet-stream",
    body,
  };
}
