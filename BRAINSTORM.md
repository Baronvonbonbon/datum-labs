# DATUM Labs — Network-Effects Test Bench

Scratchpad for lightweight services, seed apps, and contract probes deployed
*against the live DATUM network* (Paseo Hub, alpha-5) to generate real on-chain
activity and measure two- and three-sided network effects.

> This directory is intentionally **outside the `datum` git tree** — nothing here
> ships with the protocol. It's a lab. Clone the SDK / relay skeleton in, deploy,
> measure, throw away.

---

## The thing we're actually measuring

DATUM is a **three-sided marketplace**: advertisers (demand + escrow), publishers
(supply / ad inventory), and users (the extension — impressions + clicks). Network
effects show up as *cross-side elasticity*:

| Lever | Expected effect | Metric that proves it |
|---|---|---|
| + publishers (more inventory) | advertiser fill rate ↑, clearing CPM ↓ toward bid | fill rate, clearing-CPM distribution |
| + advertisers (more demand) | publisher revenue ↑, more slots clear | publisher DOT/slot, % slots cleared |
| + users per publisher | impressions/page ↑, settlement volume ↑ | impressions per pageview, settled DOT |
| denser graph overall | liquidity (demand/supply ratio) → 1, auction healthier | second-price spread, unsold-impression % |

**You cannot run any of the experiments below without instrumentation.** So Tier 0
is non-negotiable and comes first. Everything else is a source of *activity* that
the Tier-0 dashboard turns into a *case study*.

---

## Tier 0 — Instrumentation (build this first)

### 0.1 — Persistent network-effects indexer  ⭐ highest leverage
> **Not a dashboard redux.** The webapp already has 8 live, *per-role* dashboards
> (`advertiser/Analytics`, `publisher/Dashboard`, `protocol/Dashboard`, …) that
> recompute from `eth_getLogs` on every load and answer *"what is **my** current
> state?"*. This tool answers a question they architecturally cannot:
> *"how is the **whole market** changing over time?"*
>
> Three gaps the live dashboards can't fill:
> 1. **Cross-side, whole-market aggregation** — fill rate, clearing-CPM spread, and
>    the **demand/supply liquidity ratio** are properties of *all* advertisers vs *all*
>    publishers vs *all* users, not the connected wallet's slice.
> 2. **Persisted history** — Pine's log window is a rolling **~10k-block buffer**, and
>    the Paseo gateway intermittently drops topic filters (the webapp code already
>    works around this). A multi-week elasticity study *requires* its own backfilling
>    store; the live dashboards keep nothing.
> 3. **Experiment annotation** — pin metric inflections to deliberate interventions
>    ("seeded N publishers at block X") for Tier 0.2.

A headless service: backfill + tail the contract events into a local time-series
store (SQLite/Parquet is plenty), expose a small query API + chart deck.

- **Events to index:** `PublisherRegistered`, `CampaignCreated`/activated,
  `ImpressionSettled` (Settlement), `ClickRecorded` (DatumClickRegistry),
  PaymentVault credits, escrow deductions.
- **Derived metrics (the ones the webapp does *not* compute):** market-wide fill
  rate, clearing-CPM histogram + second-price spread, **liquidity ratio
  (demand/supply)**, user DAU, **k-factor** (installs attributable to existing
  users' house/referral ads). Plus the easy ones (active publishers/campaigns,
  total settled DOT, ROAS) aggregated across *all* actors.
- **Read path:** ethers against `eth-rpc-testnet.polkadot.io` for v1; optionally
  swap in **Pine** (`../datum/pine`) to prove the measurement stack runs
  trust-minimized / light-client-only.
- **Reuse:** lift the event ABIs + `queryFilterAll` workaround straight from
  `../datum/web/src/shared`. **Graduation path:** the webapp's dashboards could
  later read *from* this indexer's API instead of hitting `getLogs` raw — fixing
  their own history-blindness as a side effect.
- **Effort:** 1–2 days. **Output:** the chart deck that *is* the case study.

### 0.2 — Cohort / elasticity experiment runner
A script harness that drives a deliberate sequence and snapshots Tier-0 metrics at
each step, so the cross-side effect is *measured*, not assumed:
> week 1: add N publishers, hold demand fixed → record advertiser fill
> week 2: add M advertisers, hold supply fixed → record publisher revenue
This is what turns "we deployed some apps" into "adding 10 publishers raised fill
rate from X% to Y%."

---

## Tier 1 — Publisher-side seed apps (manufacture inventory)

Each is a real, deployable micro-site that embeds the SDK. They differ in *audience*
and *impression density* so you can compare fill/CPM across content verticals.

| # | App | Why it tests something | Impression density | Effort |
|---|---|---|---|---|
| 1.1 | **URL shortener w/ interstitial** (`s.xyz` → 3s ad page → redirect) | classic ad-supported model; pure volume; great settlement load generator | very high | low |
| 1.2 | **Pastebin / code-snippet host** | dev/crypto audience matches `topic:crypto-web3` tags → high match rate | medium | low |
| 1.3 | **Free dev tools** (planck↔DOT converter, EIP-712 signer playground, gas estimator) | hyper-targeted to the exact tag taxonomy; each tool = its own publisher | low-med | low |
| 1.4 | **"Daily crypto digest"** RSS-to-web reader | content between items = multiple slots/page; recurring DAU | high | med |
| 1.5 | **Link-in-bio builder** (many creator pages, one relay) | tests *multi-publisher density under a single relay* — the same-side scaling case | scales with creators | med |
| 1.6 | **Static blog / the DATUM docs themselves** | zero new content needed — drop SDK into `../datum/docs`; real organic traffic baseline | low | trivial |
| 1.7 | **WordPress demo site** (use the existing `wordpress-plugin`) | exercises the non-SDK integration path; proves the plugin in the wild | med | low |

**Measure per app:** fill rate, clearing CPM by tag, settlement success %, DOT/1k
impressions, no-extension fallback rate (house-ad shows).

---

## Tier 2 — Advertiser-side seed apps (manufacture demand)

| # | App | What it probes |
|---|---|---|
| 2.1 | **DATUM house campaigns** for extension/SDK installs | real acquisition funnel; k-factor; CPC→install conversion via `DatumClickRegistry` |
| 2.2 | **"Promote your repo" one-click campaign wrapper** | advertiser *onboarding friction* — how few steps to live escrow? |
| 2.3 | **Merch/store demo + conversion pixel** | full attribution chain: impression → click → landing → convert; ROAS case study |
| 2.4 | **Campaign-bidding bot** (varies CPM across a fleet of campaigns) | feeds the auction so Tier-0 can chart clearing-price dynamics as demand scales |

---

## Tier 3 — Two-sided bootstrap / cold-start

### 3.1 — Synthetic marketplace seeder ⭐ solves chicken-and-egg
A fleet of (a) scripted publisher pages, (b) headless-browser "user" bots running the
extension flow, and (c) seeded campaigns — enough baseline liquidity that *real*
participants who arrive see a working market instead of an empty one. Doubles as a
**settlement stress test** and a **k-factor sandbox**.
- Reuse `relay-bot.example` for the relay side; drive users via Playwright + the
  extension; seed campaigns via the web app's contract calls.
- Knob: ramp publisher/advertiser/user counts independently → directly feeds 0.2.

---

## Tier 4 — Smart-contract probes (testnet, not unit tests)

These run *on live Paseo* to catch behavior that unit tests don't — concurrency,
auction dynamics at scale, economic griefing.

| # | Probe | Asserts |
|---|---|---|
| 4.1 | **Multi-publisher concurrent settlement** | value conservation: Σ(publisher vaults) + protocol fees + user credits == escrow deducted, under interleaved batches |
| 4.2 | **Clearing-price / second-price auction probe** | with K campaigns of known bids on a fully-tagged page, clearing price == 2nd-highest bid; spread tracked as K grows |
| 4.3 | **Rate-limit / stake-gate griefing** | one publisher floods claims → rate-limiter + `DatumPublisherStake` reject; honest publishers unaffected |
| 4.4 | **Dual-sig vs publisher-direct vs bonded-relay** cost/latency | compare the three `data-relay-mode` paths on real gas + settlement latency |

---

## Suggested sequencing

1. **Tier 0.1 dashboard** — without it nothing is a case study.
2. **2–3 Tier-1 publishers** spanning verticals (1.1 volume, 1.3 targeted, 1.6 baseline) + **1 Tier-2 advertiser** (2.1 or 2.4).
3. **Tier 3.1 seeder** to escape cold-start and to stress-test.
4. **Tier 0.2 elasticity runner** — flip the cross-side levers and chart the curves.
5. **Tier 4 probes** opportunistically, whenever a metric looks off.

---

## Open questions for Kasey
- Real external traffic, or fully synthetic bots, or both? (changes whether 1.x or 3.1 leads)
- Is there budget for real testnet DOT escrow at the volumes a load test implies, or do we cap it?
- Should the dashboard live here (lab) or eventually graduate into `../datum/web` as an ops page?
