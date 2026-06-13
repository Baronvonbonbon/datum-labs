# Settlement Aggregation — Design & Decision Doc

**Status:** scoping (no code). Decision owner: Kasey.
**Date:** 2026-05-30.
**Resolves:** ROADMAP B1 — "per-claim settlement won't scale." This is the one
architectural call that determines whether DATUM's per-impression economics can
ever work at real ad volume. It should be made *before* investing in relay
horizontal-scaling (submitter pool, multi-tenant infra).

> This doc scopes the decision and a lab prototype. It does **not** commit
> contract changes. Numbers below are the measured lab figures plus first-order
> estimates flagged as such.

---

## 1. The wall, precisely

Measured on Paseo (alpha-5 v5, dual-sig path):

| Metric | Value | Source |
|---|---|---|
| On-chain dual-sig batch cap | **1 claim/tx** | per-tx weight cap; 2–3 reverts |
| Gas per settled claim | **~49k** | lab measurement |
| Throughput, one pipelined signer | **~65 settlements/min** (~94k/day) | `relay/src/claims.mjs` |
| Throughput, N-signer submitter pool | linear in N | not built; ROADMAP B1 |

**Two distinct ceilings — do not conflate them:**

- **Throughput ceiling** (nonces/min per signer). A submitter pool of N gas-payer
  EOAs broadcasting one relaySigner's off-chain sigs fixes this *linearly*.
  `settleSignedClaims` is permissionless, so this is clean to build.
- **Cost ceiling** (gas *per impression*). The submitter pool does **nothing**
  for this — it multiplies senders, not efficiency. At ~49k gas/claim, a real
  publisher doing millions of impressions/day pays millions × 49k gas. **This is
  the wall aggregation must break.** No amount of horizontal scaling escapes it.

The strategic error to avoid: building the submitter pool, declaring "we scaled
settlement," and shipping the per-impression cost structure to mainnet anyway.

---

## 2. Why per-claim is structurally expensive

`DatumSettlementLogicB._processBatch` does this **per claim** (read from source,
alpha-5):

- hash-chain SLOADs: `_lastNonce`, `_lastClaimHash` per `(user, campaign,
  actionType)`; then SSTOREs to advance them
- self-blocklist + curator blocklist checks
- **external call** → `DatumClaimValidator.validateClaim` (Blake2-256/keccak hash
  recompute + chain continuity)
- settlement-cap SLOAD/SSTORE; per-window cap SLOAD/SSTORE
- **external call** → `DatumSettlementRateLimiter.tryConsume` (view claims)
- **external call** → `DatumPublisherStake.isAdequatelyStaked`
- **external call** → `DatumNullifierRegistry.tryConsume` (ZK claims)
- **external call** → `DatumBudgetLedger.debit` (escrow movement)
- **external call** → `DatumPaymentVault.credit` ×3 (publisher / user / protocol)
- **external call** (non-critical) → `DatumTokenRewardVault.creditReward`
- **external call** → `DatumMintCoordinator` (DATUM emission)
- **external call** → `DatumPublisherReputation.recordSettlement`

That's **~8–10 external calls + a dozen storage slots per impression.** The cost
is irreducible *in this architecture* because validation and value-movement
happen together, per impression, on-chain.

**Key insight for aggregation:** the expensive work splits into two classes:
1. **Per-impression validation** (hash chain, nonce, PoW, ZK, nullifier,
   rate-limit, stake gate) — must be done once per claim, but **not necessarily
   on-chain**.
2. **Value movement** (escrow debit, 3× vault credit, emission, reputation) —
   only needs to touch the chain **per net recipient per epoch**, not per
   impression.

Aggregation = move class 1 off-chain (with a commitment + dispute path) and batch
class 2 into per-epoch net settlements. Every viable design below is a variation
on *where the trust boundary sits* for class 1.

---

## 3. The decision, framed as axes

Independent of any specific scheme, three axes define the design space:

- **A. Trust model for off-chained validation:**
  *Optimistic* (post a commitment + bond, fraud-proof challenge window) vs
  *Validity* (post a ZK proof that the aggregate is correct) vs
  *Trusted* (relay just asserts; backed only by dual-sig refutation + slashing).
- **B. Netting granularity:** per `(publisher)`, per `(publisher, campaign)`, per
  `(advertiser, publisher)` pair, or full global net. Finer = more on-chain rows;
  coarser = less, but needs more off-chain bookkeeping to attribute.
- **C. Epoch cadence:** every N blocks / N impressions / fixed wall-clock. Drives
  latency-to-payout vs amortization. Users wait longer for coarser epochs.

The protocol already owns primitives that bias the answer (see §5).

---

## 4. Candidate designs

### Option 0 — Submitter pool only (the non-answer)
Build the N-EOA submitter pool; leave per-claim settlement as-is.
- **Effort:** small. **Throughput:** linear in N. **Cost/impression:** unchanged.
- **Verdict:** necessary eventually, insufficient alone. **Does not resolve B1.**
  Listed only to name it explicitly so it isn't mistaken for the fix.

### Option 1 — Optimistic aggregated checkpoint ⭐ recommended starting point
Relay (or any aggregator) accumulates validated claims off-chain, periodically
posts a **Merkle root over `(recipient → net owed this epoch)`** plus an aggregate
escrow-debit total, backed by a bond. A challenge window lets anyone submit a
fraud proof (a Merkle path to a leaf that contradicts the on-chain claim/nullifier
state). Recipients pull from the vault against a finalized root.
- **On-chain per epoch:** 1 root commit + escrow debit + (lazy) per-recipient
  pull. Per-impression on-chain cost → **amortized to near-zero**.
- **Trust:** aggregator can't steal — a bad root is challengeable and slashes the
  bond; honest roots finalize after the window.
- **Effort:** **medium** — and this is the decisive point: **it reuses an
  in-house pattern.** `DatumStakeRootV2` is already a bonded-reporter,
  Merkle-root-commit, fraud-proof-challenge, phantom-leaf-slashing system. A
  `DatumSettlementRoot` is structurally the same contract aimed at settlement
  deltas instead of stake leaves.
- **Cost:** latency-to-finality = challenge window (hours–day); needs watchtower
  incentives so someone actually challenges; off-chain validation engine becomes
  the relay's core (it must replicate `ClaimValidator` logic exactly).

### Option 2 — ZK-rollup-style validity aggregation
A circuit proves: "these N claims are individually valid (hash chain, nonce, PoW,
nullifier non-replay) and their net deltas are `D`." Post one Groth16 proof + new
state root; Settlement verifies and moves netted value.
- **On-chain per epoch:** 1 proof verify + netted credits. Best asymptotics; no
  challenge-window latency.
- **Trust:** trust-minimized — strongest fit for the cypherpunk end-state.
- **Effort:** **high** — a new circuit (much larger than the current
  single-impression circuit), a recursive/aggregation proving system, and an
  **MPC ceremony** (already a pending mainnet item for the existing circuits;
  this adds a second, bigger one). Proving infra becomes operational surface.
- **Reuses:** `DatumZKVerifier` (Groth16/BN254) verifier machinery, the existing
  nullifier/claim-hash construction as circuit inputs.

### Option 3 — Payment channels / pairwise netting
Open an advertiser↔publisher (or relay↔publisher) channel; settle impressions
off-chain against a running balance; close to chain periodically or on dispute.
- **On-chain:** open + close + dispute only. Extremely cheap per impression.
- **Trust:** strong for the *two parties in the channel*; mismatched with DATUM's
  three-sided split (user + publisher + protocol all get paid per impression, and
  the **user** is the party whose payout matters most for adoption — channels are
  awkward when the value recipient isn't a channel counterparty).
- **Effort:** medium-high; **poor fit** for the user-payout leg. Plausible as a
  *supplementary* path for high-volume direct advertiser↔publisher deals (which
  is already what L2 dual-sig is for), not the general mechanism.

### Option 4 — Hybrid by AssuranceLevel (the likely real answer)
Route by AssuranceLevel and volume:
- **L0/L1 high-volume view impressions** → Option 1 optimistic checkpoint
  (the bulk of traffic; cheapness matters most, individual claim value is tiny).
- **L2 dual-sig direct deals** → keep per-claim `settleSignedClaims` (already the
  high-value, low-volume, independently-co-signed path; refutation guarantee is
  the product).
- **L3 ZK-only** → per-claim today; migrate to Option 2 if/when the ZK
  aggregation circuit + ceremony land.

This matches the gradient the protocol *already* encodes and lets the cheap path
ship first without weakening the high-assurance paths.

---

## 5. What the protocol already gives us (bias toward Option 1 → 4)

- **`DatumStakeRootV2`** — bonded reporters commit Merkle roots; fraud-proof +
  phantom-leaf challenge + `markInactive` eviction. **This is 80% of an optimistic
  settlement-root contract.** Strongest argument for starting with Option 1.
- **`DatumZKVerifier`** + impression circuit + `DatumNullifierRegistry` — the
  building blocks for Option 2, but gated on a new circuit + MPC ceremony.
- **Hash-chained claims** (`previousClaimHash`/`nonce` per `(user, campaign,
  actionType)`) — claims are *already* a per-user ordered log, which is exactly
  the structure an off-chain aggregator needs to compute net deltas and prove
  continuity.
- **Permissionless `settleSignedClaims`** — submitter-pool-friendly; the
  aggregator and the submitter are already decoupled.
- **`DatumUpgradable` registry + lock-once `migrate`** — a new
  `DatumSettlementRoot` slots into the router as a new registered contract;
  doesn't require rewriting Settlement (it becomes an *additional* entry point,
  like DualSig is today). Note the unfixed router `migrate` wedge
  (`PRE-MAINNET-CHECKLIST.md` U1) only matters if we *replace* a stateful
  contract — adding a new one alongside is clean.

**Provisional recommendation:** pursue **Option 1, structured as Option 4** —
build a `DatumSettlementRoot` modeled on `StakeRootV2` for the high-volume L0/L1
lane, keep per-claim DualSig for L2, defer Option 2 until the ZK ceremony work is
already happening anyway. Confirm with the lab measurements in §6 first.

---

## 6. What the lab can prototype NOW (no contract changes, no browser)

Everything here is buildable in `datum-labs` against the live deploy and feeds the
decision before any Solidity is written:

1. **Net-delta aggregator (off-chain only).** Extend the relay to accumulate the
   claims it already receives into a per-epoch `(recipient → net owed)` table and
   compute the Merkle root it *would* post. No on-chain commit yet — just prove the
   aggregation math and measure: how many impressions collapse into how few payout
   rows at realistic `(publisher, campaign, user)` cardinality? **This sizes the
   on-chain savings directly** and is the single highest-value experiment.
2. **Per-mode cost/latency benchmark (BRAINSTORM 4.4).** Drive the same load
   through publisher-direct (L0/L1), dual-sig (L2), and bonded-relay paths via
   `relay/scripts/load.mjs`; record real gas + settlement latency per path. Tells
   us which lane aggregation matters most for.
3. **Indexer escrow/vault coverage.** Add `BudgetLedger` debit + `PaymentVault`
   credit/withdraw events so we can verify value conservation (probe 4.1) — a
   prerequisite for trusting *any* aggregated net-delta scheme against ground
   truth.
4. **Challenge-economics simulation.** Model watchtower incentive: at DATUM
   impression values (~$0.0009 user/impression at recommended CPM), what bond +
   reward makes challenging a fraudulent root rational? If individual-impression
   value is too low to motivate challengers, optimistic aggregation needs the
   *aggregator's* bond to carry the deterrence, not per-leaf rewards. **This is the
   gating risk for Option 1** and is pure off-chain modeling.

None of these need the extension or new contracts; all sharpen the decision.

---

## 7. Decision criteria

Pick the design once these are answered:

- **Compression ratio** (experiment 6.1): if realistic traffic collapses ≥100:1
  impressions→payout-rows, Option 1's economics are compelling. If it's ~5:1
  (many tiny one-off users), the on-chain pull cost dominates and the math is
  weaker — revisit netting granularity (axis B).
- **Which lane is the cost wall** (6.2): if L0/L1 view traffic is the volume,
  Option 4-with-Option-1 is right. If the volume is L2 direct deals, channels
  (Option 3) re-enter consideration.
- **Challenger economics** (6.4): if no rational challenger exists at impression
  value, either lean on aggregator-bond deterrence (still Option 1, different
  parameterization) or accept that trust-minimization requires Option 2.
- **Mainnet timeline vs ZK ceremony:** if the MPC ceremony for the existing
  circuits is near-term anyway, the *marginal* cost of Option 2's circuit drops
  and validity aggregation becomes more attractive for the long run.

---

## 8. Open questions for Kasey

1. **Latency tolerance:** is an hours-to-a-day challenge-window delay on user
   payout acceptable (Option 1), or is instant finality a product requirement
   (pushes toward Option 2)?
2. **Cypherpunk posture:** does the end-state *require* trust-minimized settlement
   (Option 2 eventually mandatory), or is a bonded-aggregator-with-fraud-proofs
   (Option 1) an acceptable permanent design given it mirrors `StakeRootV2`, which
   the protocol already trusts for stake roots?
3. **Who runs the aggregator** and what's its cut? Ties to ROADMAP B2 (relay
   economics) — the aggregator bond + fee model are the same conversation.
4. **Netting granularity (axis B):** is per-`(publisher, campaign)` net enough, or
   do per-user payout rows have to appear on-chain each epoch for the user-earnings
   UX? (Determines the compression ratio and thus the whole economic case.)
5. **Scope of this line vs mainnet:** is aggregation a pre-mainnet blocker, or a
   post-launch scaling upgrade that the upgrade-ladder (`DatumUpgradable`) is meant
   to deliver later? The answer changes whether this competes with the
   `PRE-MAINNET-CHECKLIST.md` items for priority now.
