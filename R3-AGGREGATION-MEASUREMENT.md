# R3 — Settlement-aggregation compression measurement

**Date:** 2026-06-14. **Companion:** `SETTLEMENT-AGGREGATION-DESIGN.md` (the build
decision this feeds), `RELEASE-PLAN.md` R1.5. **Status:** first real on-chain
measurement — the harness is proven; the number is directional but low-volume.

## Method
1. Two diana-published, relay-settleable campaigns: **#9** (advertiser bob) + **#10**
   (advertiser charlie) — both gasless via the diana relay + bob/charlie cosigners.
2. Returning-user load (chain-aware `load-returning`, datum-labs PR #3):
   `--campaigns 9,10 --pool 12 --impressions 70 --skew 1.2 --seed r3demo` →
   16 distinct (user×campaign) pairs settled gaslessly through the relay (0 rejected).
3. Indexer backfilled over the recent window; compression read from
   `indexer /api/aggregation` (`metrics.js::aggregation`, epoch = 14400 blocks).

## Result — two reuse regimes

| metric | low reuse (1 claim/pair) | **heavy reuse (per-pair chains)** |
|---|---|---|
| settled claims | 24 | **202** (≥200 → trustworthy) |
| impressions | 78 | 548 |
| distinct users | 14 | 38 |
| distinct campaigns | 3 | 3 |
| **compressionVsClaims** | 1.26 | **4.3** |
| **compressionVsImpressions** | 4.11 | **11.66** |

The heavy-reuse run (pool 20 × 2 campaigns × `--per-pair 5`, 202 claims) clears the
metric's own ≥200 trustworthiness bar. compressionVsClaims rises from 1.26 (mostly
distinct users) to **4.3** as users repeat (the realistic-market shape); vsImpressions
reaches **11.66**.

## Reading it
- **Impression→claim netting already wins ~4×** (`compressionVsImpressions ≈ 4.11`):
  aggregated mode folds many impressions into one claim via `eventCount`, **client-side,
  with no new contract**. This is the cheap, already-shipped lever.
- **Claim→on-chain-row netting is weak here (~1.26×):** a `DatumSettlementRoot`
  checkpoint would replace ~1.26 per-claim txs with one aggregated row at this
  cardinality — far below the design doc's **≥10 "build it"** rule of thumb, and in
  its **"~1–3 → revisit netting granularity before committing"** zone.
- Structurally, `compressionVsClaims ≈ claims / (users + publishers + campaigns + 1)`,
  so it only climbs with heavy **per-user repeat** settlement (an earlier 50-user
  reuse run hit ~2.42). Even with strong reuse it stays in the low single digits —
  not the order-of-magnitude that justifies the aggregation build.

## Decision implication
**Hold on building settlement aggregation (`DatumSettlementRoot`) — it's borderline,
lean no for now.** Even under heavy reuse, **claim→row netting is ~4.3×**, still under
the design doc's **≥10 "build it"** rule of thumb (and in/just above its "~1–3 → revisit
netting granularity" zone). Meanwhile the **impression→claim netting already wins ~11.7×
client-side** (aggregated mode's `eventCount`, no new contract). So most of the
compression is already captured for free; an on-chain checkpoint would add ~4× more at
heavy reuse — real, but not the order-of-magnitude that clearly justifies the build +
fraud-proof complexity. Revisit **netting granularity** (per-user cross-campaign netting,
longer epochs) first, and re-measure if production reuse runs heavier than this.

## Caveat / when to revisit
The 202-claim run is trustworthy (≥200) but reuse here is synthetic (`--per-pair 5` on a
20-user pool). The decision is reuse-sensitive: vsClaims scaled 1.26 → 4.3 as reuse rose,
so if *real* users repeat even more heavily (or across many more campaigns) it could
approach the ≥10 threshold. Re-run against real production traffic before a firm commit.
Harness in place: `load-returning` (chain-aware) + indexer `/api/aggregation` + the
relay/cosigner fleet.

## Repro
```bash
# 1. ensure relay-settleable campaigns exist (publisher=diana, advertiser=bob/charlie)
# 2. returning-user load (gasless):
cd datum-labs/relay && node scripts/load-returning.mjs --campaigns 9,10 \
  --pool 12 --impressions 70 --skew 1.2 --seed r3demo --concurrency 5
# 3. measure:
cd ../indexer && START_BLOCK=<recent> node src/index.js backfill
node -e "import('./src/metrics.js').then(M=>console.log(JSON.stringify(M.aggregation(),null,2)))"
```
