# DATUM — Gaps to a Viable Market

Strategic gap analysis: what's left between the working lab tooling and a suite of
tools/features a *real* two-sided market could run on. Written 2026-05-29 after the
lab tooling (indexer, publisher-shortener, relay + scripts) was proven e2e on Paseo.

See `BRAINSTORM.md` for the idea backlog and `README.md` for the tooling status.

---

## What the lab proved vs. didn't

The tooling validated the **plumbing**: claims construct correctly, dual-sig
verifies, settlement pays the right split, gas ≈ 49k/claim, throughput tunes to
~65 settlements/min (pipelined). That's the hard part of *correctness*.

But every test used **synthetic, fully-controlled actors**:
- fake users — `userSig` is `0x00`, ignored by the dual-sig path;
- the relay held **both** the publisher and advertiser keys.

**The unvalidated frontier is everything involving an adversarial or independent
third party.** That is the through-line for nearly every gap below.

---

## Tier A — blocks *any* real market (trust & correctness)

### A1. Independent advertiser co-signing  ⭐ highest priority
The lab put `ADVERTISER_PRIVATE_KEY` in the relay so it could sign both sides.
In production that is fatal: the publisher's relay holding the advertiser's key
**defeats the entire dual-sig refutation guarantee** ("either party can withhold
their sig"). 
- **Build:** an advertiser-owned co-signing service (mirror of the relay's
  EIP-712 sign path) that independently signs *or refuses* batches, plus the UX
  for advertisers to run or delegate it.
- **Until then dual-sig is theater.**

### A2. Real user / extension path
Never exercised: the actual extension → SDK challenge-response → on-device
impression attestation → user-signed claim flow on alpha-5. This is the
demand-*fulfillment* side, and the "impressions are real, not injected" property
lives entirely here.
- **Validate:** one real browser, one real impression, settled on-chain.

### A3. Relay abuse protection
Today the relay accepts all campaigns and pays gas for any posted claim — a pure
griefing/DoS vector. Needs auth (HMAC), rate-limiting, per-publisher scoping, and
TLS before it faces the open internet. (Already noted in `PRE-MAINNET-CHECKLIST.md`.)

---

## Tier B — blocks scale & economics

### B1. Per-claim settlement won't scale  ⭐ architectural decision
Measured: dual-sig batch cap is **1** on this chain, ~49k gas each. One pipelined
signer ≈ 94k settlements/day; real ad volume is millions/day, and the **gas cost
itself** is the wall (not just nonce throughput). The submitter pool scales
linearly but doesn't change the per-impression cost.
- **Feature gap:** settlement **aggregation** — roll many claims into periodic
  on-chain checkpoints (Merkle/ZK), settle deltas, not every impression. Decide
  this *before* scaling relay infra.

### B2. Relay economics
The relay pays everyone's gas. Who funds it, and what's its cut? Needs a fee model
and the **bonded `DatumRelay` path** productionized as the sustainable alternative
to publisher-direct settlement.

### B3. Fraud / quality measurement
PoW + stake + ZK are anti-sybil *primitives*, untested against a real adversary.
Advertisers won't spend real budget without confidence impressions aren't bot
farms. Needs a quality/fraud-scoring tool and evidence the primitives hold.

---

## Tier C — blocks adoption (the two-sided cold-start)

### C1. Supply is the scarce side — structurally
Every lab run showed **liquidityRatio ~55–58**: hundreds of campaigns, **3
publishers**. Adding demand is trivial; real publishers with real traffic is the
bottleneck. Needs publisher acquisition + the SDK proven on diverse real sites +
viable no-extension fallback economics.

### C2. User payout loop end-to-end
Users earn DOT + DATUM, but the withdraw → value path (emissions, fee-share
staking, bootstrap pool) was never validated. If the incentive doesn't pay out
smoothly, extension adoption never happens → no users → no impressions → no market.

---

## Tier D — mainnet hardening (tracked elsewhere)

Key-hygiene scrub, cypherpunk lock ladder, upgrade machinery, audit completion,
token-plane sunset. These gate *mainnet*, not *viability proof* — see
`PRE-MAINNET-CHECKLIST.md`.

---

## Recommendation

**Don't build more lab tooling — cross Tier A, where "synthetic" becomes "real."**

1. **Stand up an independent advertiser co-signer** (A1) and re-run the e2e with
   publisher and advertiser as genuinely separate services. Small build atop what
   exists; proves dual-sig for real.
2. **Validate the real extension flow** (A2) against the publisher-shortener — one
   real browser, one real impression, settled. Verification, not construction.
3. **Make the settlement-aggregation call** (B1) — the one architectural decision
   that determines whether the economics can ever work.

The fastest "is this real?" test is **#1 + #2 together**: a real impression in a
real browser, co-signed by two independent parties, settled on-chain. If that
works, the *mechanism* is viable; everything else is scale, economics, adoption.

> Confidence caveat: the state of the extension flow (A2), advertiser tooling (A1),
> and user payout path (C2) is **inferred** — those subsystems weren't read when
> this was written. Verify before committing effort; they may be further along (or
> behind) than assumed.
