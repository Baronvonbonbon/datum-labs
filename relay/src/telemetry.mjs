// In-memory counters + a small ring buffer of recent events, surfaced via
// /metrics and /events (same shape as the canonical skeleton).
const counters = {
  clicksReceived: 0,
  clicksSubmitted: 0,
  clickErrors: 0,
  claimsReceived: 0,
  claimsSubmitted: 0,
  claimsConfirmed: 0,
  claimBatchesSubmitted: 0,
  claimErrors: 0,
  settledCount: 0,
  rejectedCount: 0,
};

const RING = 200;
let seq = 0;
const events = [];

export const bump = (k, n = 1) => (counters[k] = (counters[k] || 0) + n);

export function record(type, data = {}) {
  seq += 1;
  events.push({ id: seq, t: Date.now(), type, ...data });
  if (events.length > RING) events.shift();
}

export function eventsSince(since) {
  const s = Number(since) || 0;
  return events.filter((e) => e.id > s);
}

let _status = { chainId: null, signer: null, advertiserSigner: null, inflight: 0, queued: 0, pendingApproval: 0 };
export const setStatus = (s) => Object.assign(_status, s);

export function snapshot() {
  return { ...counters, ..._status, ts: Date.now() };
}
