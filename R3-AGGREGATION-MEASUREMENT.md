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

## Result (epoch 696)
| metric | value |
|---|---|
| settled claims | 24 |
| impressions | 78 |
| distinct users | 14 |
| distinct publishers | 1 |
| distinct campaigns | 3 |
| aggregatedRows (users+pubs+camps+1) | 19 |
| **compressionVsClaims** | **1.26** |
| **compressionVsImpressions** | **4.11** |

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
**Do not build settlement aggregation (`DatumSettlementRoot`) yet.** The data says the
big compression is already captured client-side (impression→claim, ~4×); the on-chain
claim→row netting (~1.3–2.4×) doesn't clear the threshold. Per
`SETTLEMENT-AGGREGATION-DESIGN.md`, revisit the **netting granularity** (e.g. per-user
cross-campaign netting, longer epochs) before committing Solidity.

## Caveat / rigorous follow-up
Volume is low (24 claims; the metric wants **≥200** to be trustworthy). The *direction*
is clear (vsClaims stays low-single-digit under this netting model), but before any firm
commit, run a sustained ≥200-claim load with a larger returning pool + `--per-pair` chains
and re-read `/api/aggregation`. Everything needed is in place:
`load-returning` (chain-aware) + the indexer aggregation endpoint + the relay/cosigner
fleet.

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
