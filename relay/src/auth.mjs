// Shared-secret HMAC for the controlled-exposure phase. Gates the gas-spending
// write endpoints (/claim, /click) and the relay→co-signer call so only trusted
// testers can reach them once the service is on a public tunnel.
//
// SCOPE: this is a trusted-tester gate, NOT the public auth model. In production
// the SDK/extension posts claims and can't hold a secret — that path needs real
// impression attestation (roadmap A2) + rate-limiting, not a shared secret.
//
// Scheme: X-Datum-Ts (unix secs) + X-Datum-Sig = HMAC-SHA256(secret, `${ts}.${body}`).
// Timestamp window bounds replay. Disabled (open) when the secret is unset.
import { createHmac, timingSafeEqual } from "node:crypto";

const WINDOW_SEC = 300;

export function signHeaders(secret, body) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return { "x-datum-ts": ts, "x-datum-sig": sig };
}

export function verify(secret, headers, rawBody) {
  const ts = headers["x-datum-ts"];
  const sig = headers["x-datum-sig"];
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > WINDOW_SEC) return false;
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
