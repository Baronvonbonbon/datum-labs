// HMAC verify for /cosign (controlled-exposure gate). Mirrors the relay's auth.mjs.
// COSIGN_SECRET must equal the relay's ADVERTISER_COSIGNER_SECRET. Open when unset.
import { createHmac, timingSafeEqual } from "node:crypto";

const WINDOW_SEC = 300;

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
