# DATUM Indexer

A standalone, persistent event indexer for the DATUM ad exchange on Paseo Hub.
Backfills + tails contract events into SQLite and serves the **whole-market**
network-effect metrics the per-wallet webapp dashboards can't compute.

## Why this exists (vs. the webapp dashboards)

The `datum/web` app has 8 live dashboards, but they're **per-role, live-read, and
stateless** — they recompute from `eth_getLogs` on each load and keep no history.
This tool fills three gaps they can't:

1. **Whole-market aggregation** — fill rate, clearing-CPM spread, and the
   demand/supply **liquidity ratio** are properties of *all* advertisers vs *all*
   publishers vs *all* users, not the connected wallet's slice.
2. **Persisted history** — Pine's log window is a rolling ~10k-block buffer. A
   multi-week elasticity study needs its own backfilling store.
3. **Experiment annotation** — pin metric inflections to deliberate interventions.

## What it indexes

| Event | Contract | Feeds |
|---|---|---|
| `ClaimSettled` | Settlement | impressions, settled DOT, clearing rate, payment split, DAU |
| `ClaimRejected` | Settlement | settlement-success (fill) proxy |
| `ClickRecorded` | ClickRegistry | clicks, CTR |
| `CampaignCreated` / `CampaignActivated` | Campaigns | demand side, budget utilization |
| `PublisherRegistered` | Publishers | supply side |
| `SettlementCredited` | PaymentVault | value conservation (credited == settled) |
| `Publisher/User/ProtocolWithdrawal` | PaymentVault | DOT actually withdrawn (payout loop) |
| `SweptToFeeShare` | PaymentVault | protocol-fee → FeeShare yield source |
| `MintComputed` / `DatumMintFailed` | EmissionEngine / MintCoordinator | DATUM emission leg (dark until token plane deploys) |

## Run

```bash
npm install                 # builds better-sqlite3 (native)
cp .env.example .env        # optional — defaults target ../../datum/alpha-core

# Backfill + tail (writes data/datum.db):
npm start
# or one-shot backfill:
npm run backfill

# In another terminal, serve the metrics API + chart deck:
npm run serve               # → http://localhost:4319
```

> **First full study:** set `START_BLOCK` in `.env` to the alpha-core deploy block
> (deployed 2026-05-23) so the backfill covers the whole history. Left on `auto`,
> it only indexes the last `BACKFILL_DEPTH` blocks.

## Metrics API

- `GET /api/summary` — market totals + liquidity ratio, eCPM, fill proxy
- `GET /api/timeseries` — daily buckets (impressions, settled DOT, DAU, new pubs/campaigns, clicks)
- `GET /api/cpm-histogram` — clearing-rate distribution
- `GET /api/top-publishers`, `GET /api/top-campaigns`
- `GET /api/conservation` — **(R1.3)** value-conservation probe: settled vs credited
  vs withdrawn (solvency), + the DATUM emission leg (dark until the token plane deploys)
- `GET /api/aggregation[?epochBlocks=N]` — **(R1.5)** settlement-aggregation
  compression measurement; gates the `DatumSettlementRoot` decision (see
  `../SETTLEMENT-AGGREGATION-DESIGN.md`)
- `GET /api/status` — cursor block + counts

> **R1.3 re-backfill required.** `paymentVault` / `emissionEngine` /
> `mintCoordinator` were added to the watch set in this version. A DB indexed
> before the upgrade never fetched their logs (filtering is by address). To
> populate `vault_credits` etc., re-backfill from the alpha-core deploy block:
> `npm run reset && START_BLOCK=<deployBlock> npm start`.

> **R1.5 honesty note.** Compression comes from **user/publisher reuse** across an
> epoch, not from raw volume. The current synthetic injector uses a *fresh random
> user per claim* (worst case: `meanCompressionVsClaims < 1`). The R1 load test
> must model **returning users** or it will badly understate the real ratio.

## Metric definitions (honesty notes)

- **Fill rate** here = *settlement success rate* = settled ÷ (settled + rejected
  claims). True auction fill (bids attempted vs. won) isn't fully on-chain; this is
  the closest on-chain proxy.
- **Liquidity ratio** = active campaigns ÷ registered publishers (demand/supply).
- **eCPM** = settled DOT per 1000 impressions.
- **k-factor** is *not* computed yet — it needs install-attribution data from the
  Tier-2 house campaigns (see `../BRAINSTORM.md`).

## Notes

- Reads through the eth-rpc gateway for full history (Pine is forward-only). Swap
  `RPC_URL` for a Pine endpoint once you've registered a historical fallback.
- Idempotent: re-running resumes from the stored cursor; dedup is on (tx, logIndex).
- `npm run reset` wipes the DB.
