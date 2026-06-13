# DATUM — Fully-Functional Release Plan

**Date:** 2026-05-30. **Owner:** Kasey.
**Companion docs:** `FINDINGS-2026-05-30.md` (gap analysis),
`SETTLEMENT-AGGREGATION-DESIGN.md` (B1 decision), `../datum/PRE-MAINNET-CHECKLIST.md`.

## Decisions locked (2026-05-30)

| # | Decision | Choice |
|---|---|---|
| 1 | Release scope | **All three, sequenced**: real-market proof → public toolkit → mainnet |
| 2 | Aggregation timing | **Prototype + measure now, decide after data** (no contract changes yet) |
| 3 | Aggregation trust model | **Hybrid by AssuranceLevel** — optimistic bonded checkpoint for L0/L1, per-claim dual-sig for L2, ZK for L3 later |
| 4 | User-payout latency | **Hours-to-a-day OK** → optimistic challenge window is acceptable |
| 5 | R1 traffic source | **Both** — Kasey hand-verifies the real extension path once (1.1); a Playwright + extension bot fleet generates sustained volume for measurements (1.2/1.5) |
| 6 | Testnet escrow budget | **Fund realistic volume** — run real load (toward millions-of-impressions scale); measure actual compression, no extrapolation. Needs a sustained-faucet strategy |
| 7 | Toolkit/indexer home | **Own public repo(s)** — relay toolkit (relay+cosigner+deploy) becomes its own versioned OSS repo; indexer joins it or its own. Kept OUT of the audited protocol tree. (datum may still *operate* reference instances — hosting ≠ code home; see R2.6) |
| 8 | Timeline | **No hard deadline — correctness first.** Sequence R1→R2→R3 without compressing for a date; no corner-cutting to hit milestones |

These confirm the `SETTLEMENT-AGGREGATION-DESIGN.md` recommendation (Option 1
structured as Option 4, reusing the `DatumStakeRootV2` fraud-proof pattern), gated
on the lab compression-ratio measurement before any Solidity is written.

---

## The release train

```
R1  Real-market proof (testnet)        ── proves the mechanism with real actors
        │                                  + measures the aggregation case
        ▼
R2  Public relay toolkit                ── make it safe for a stranger to run
        │                                  + fee model informed by R1 cost data
        ▼
R3  Mainnet                             ── aggregation (if R1 data supports),
                                           audit, ceremonies, shims, locks
```

R1 and most of R2 can overlap; R3's aggregation build is gated on R1.5 data, and
R3's audit is gated on R2 + aggregation code being final.

---

## R1 — Real-market proof (testnet)

**Goal:** one real impression, in a real browser, co-signed by two independent
parties, settled on-chain — with the whole-market economics measured and value
conservation verified. Turns "synthetic" into "real."

| WS | Workstream | Owner | Needs browser? | Needs contracts? |
|---|---|---|---|---|
| 1.1 | **A2 extension flow** — extension → SDK handshake → on-device claim → user-signed → independent dual-sig (relay + cosigner) → on-chain | **Kasey (manual)** | yes | no |
| 1.2 | **Per-mode cost/latency benchmark** (BRAINSTORM 4.4) — drive load via a **Playwright + extension bot fleet** through L0/L1 publisher-direct, L2 dual-sig, bonded-relay; record real gas + latency | lab | bots | no |
| 1.3 | ✅ **Indexer vault/emission coverage** — `PaymentVault` `SettlementCredited`/`*Withdrawal`/`SweptToFeeShare` + `MintComputed`/`DatumMintFailed` indexed; `/api/conservation` probe (settled==credited, solvency) live. *Note: `BudgetLedger` emits no per-debit event — `ClaimSettled` already carries the debit. Token plane not deployed to this testnet, so the DATUM emission leg is dark until `deploy-token.ts` runs.* | lab | no | no |
| 1.4 | **+2 near-free publishers** — SDK into `../datum/docs` (BRAINSTORM 1.6) + WordPress demo (1.7) → move liquidity ratio off 3 publishers, prove non-SDK path | lab | for verify | no |
| 1.5 | ◑ **Aggregation measurement harness** — `/api/aggregation` computes the impressions/claims→payout-rows **compression ratio** at multiple epoch sizes + netting granularities from indexed settlements. *Built; awaiting real volume.* Returning-user load driver built (`relay/scripts/load-returning.mjs`: fixed pool + Zipf activity + optional `--seed` for cross-run reuse; verified 50-user pool → `compressionVsClaims 2.42` vs fresh-random's <1). Remaining: relay-side Merkle-root prototype + challenger-economics sim. **Early finding: compression is driven by user/publisher REUSE, not volume — the load test must use `load-returning`, not `load`.** | lab | bots | no |

**Traffic model (decision 5):** 1.1 is one hand-verified real-browser impression
(proves "real"). 1.2 + 1.5 then use a Playwright + extension bot fleet (reuse
`relay-bot.example` + `load.mjs`) for the volume the measurements need.
**Escrow (decision 6):** fund realistic volume — push toward millions-of-impressions
scale so the compression ratio and per-mode cost numbers are *measured, not
extrapolated*. **Funding model (decision 6a):** Kasey seeds one master EOA from the
faucet; a **top-up loop distributes PAS on demand** to N advertiser/relay EOAs
during the run (hands-off once seeded; bounded by the master balance). ✅ Built:
`relay/scripts/topup.mjs` (`npm run topup`) — derives targets from the `.env` keys,
tops below-`--min` accounts up to `--to`, holds the master above `--reserve`, warns
when low. Handles the Paseo unit asymmetry (18-dec `getBalance` wei vs 10-dec
tx-value planck).
**Timeline (decision 8):** no date pressure — sequence for correctness. Natural
order is 1.3 (instrumentation) → 1.1 (real proof) → 1.2/1.5 (measure) → 1.4
(supply), since you can't trust any measurement before the indexer can verify
value conservation.

**R1 exit criteria:**
- [ ] A real browser impression settles on-chain via two independent keys (1.1).
- [ ] Indexer verifies Σ(vault credits) + protocol fees == escrow debited (1.3).
- [ ] Compression ratio measured at realistic cardinality; challenger economics
      modeled — the two numbers that decide aggregation viability (1.5).
- [ ] Real gas + latency recorded for all three relay modes (1.2).
- [ ] Liquidity ratio moved by ≥2 new live publishers (1.4).

**Start-now (no browser, no contract risk):** 1.3, 1.5, 1.2, 1.4 are all
buildable immediately against the live deploy.

---

## R2 — Public relay toolkit release

**Goal:** a stranger can stand up a relay + advertiser-cosigner safely from a
clean install path. RELAY-TOOLKIT-SCOPE M2 → M3. (M1 operable + systemd already
shipped.)

| WS | Workstream | Maps to |
|---|---|---|
| 2.1 | **Packaging** — `npx datum-relay init` (gen keys, write `.env` + `relay.config.json`, print the `setRelaySigner` tx); versioned releases; per-role READMEs (publisher-relay operator vs advertiser) | SCOPE §1 |
| 2.2 | **Security hardening** — `/claim` rate-limiting, dashboard auth, hot-vs-cold key default (`setRelaySigner(hotKey)`), secret rotation tooling | SCOPE §4, ROADMAP A3 |
| 2.3 | **Monitoring/alerting** — low-gas-balance / error-rate / stuck-tx / cosigner-unreachable / queue-backlog alerts; Prometheus `/metrics`; reconciliation ("did claim X settle?") + daily settled-vs-gas P&L; per-publisher breakdowns | SCOPE §3 |
| 2.4 | **Config grade** — hot reload of `relay.config.json`; on-chain `relaySigner` pre-verify (save gas on mismatch); cosigner allowlist + pacing parity | SCOPE §2 |
| 2.5 | **Economics** — operator fee model (config'd bps cut); submitter pool (N gas-payer EOAs broadcasting one relaySigner's sigs — the throughput lever). Fee model informed by R1.2 cost data | SCOPE §5, ROADMAP B2 |
| 2.6 | **Graduation to own public repo(s)** (decision 7) — relay toolkit (relay+cosigner+deploy) as its own versioned OSS repo, OUT of the audited protocol tree; indexer joins it or stands alone. Separately, datum *operates* reference instances (see below) | FINDINGS gap #8 |

### Graduation framing (decision 7) — own public repo(s); datum operates reference instances

**Code home = standalone public repo(s)** (e.g. `datum-relay-toolkit`, optionally
`datum-indexer`). Versioned, OSS, so anyone runs the same code — and it stays
clear of the audited protocol tree (audit scope = contracts only). This is the
"where the code lives" answer.

**Separately, datum can still *operate* hosted reference instances** of that
public code (hosting ≠ code home), reusing the existing systemd + Cloudflare-tunnel
pattern. Per service:

- **Indexer → operate a hosted instance unreservedly.** Read-only analytics
  (block-explorer-class). Wire the webapp dashboards to read from it → fixes their
  rolling-10k-block history-blindness (BRAINSTORM 0.1). **Keep Pine light-client as
  the trustless read fallback** so the hosted indexer is convenience, not a required
  dependency.
- **Relay → operate a canonical *reference* relay, "default not mandatory."**
  Lowers onboarding friction + great for demos. Keep it one-of-many: publishers
  may delegate `relaySigner` elsewhere, bonded-relay path stays open, code is the
  public toolkit. Needs R2.5 fee model + hot-key hygiene (it pays gas).
- **Cosigner → operate ONLY for DATUM house campaigns.** A datum-hosted cosigner
  for *third-party* campaigns would re-merge the advertiser key into the relay's
  trust domain and **defeat dual-sig (re-opens A1)**. House campaigns are honest
  (datum *is* the advertiser). Ship the cosigner as toolkit software for real
  advertisers to self-run.

**R2 exit:** the toolkit is a standalone public repo a stranger runs from `init` +
systemd, with balance + error alerts and dashboard auth; datum operates a hosted
indexer (webapp reads from it, Pine fallback intact) + a reference relay
(default-not-mandatory); fee model live.

---

## R3 — Mainnet (Polkadot Hub)

**Goal:** audited, ceremonied, locked, deployed with viable per-impression
economics. The `PRE-MAINNET-CHECKLIST.md` in full, plus aggregation.

| WS | Workstream | Gate |
|---|---|---|
| 3.1 | **Aggregation build (conditional)** — if R1.5 compression ≥ threshold: build `DatumSettlementRoot` (optimistic, modeled on `StakeRootV2`) for the L0/L1 lane + off-chain engine + migration tests. Keep per-claim dual-sig for L2. New router-registered contract (clean — additive, not a stateful replacement) | R1.5 data |
| 3.2 | **Upgrade machinery U1–U7** — fix the `router.upgradeContract` `msg.sender` wedge (U1, currently a silent no-op); `_migrate()` overrides on stateful contracts (U2); gas-paginated migration (U3); coordinated-rotation decision (U4); migration test harness (U5); indexer/consumer partial-migration guards (U6) | checklist §U |
| 3.3 | **External security audit** — re-audit obligation: ~36 contracts touched by the upgrade-ladder retrofit; internal pass found 4 HIGH | 3.1, 3.2 final |
| 3.4 | **MPC ceremonies** — impression circuit + identity circuit (single-party setups are testnet-only) | — |
| 3.5 | **Shim replacements** — Wrapper unwrap XCM path (L3), AssetHubPrecompile → real precompile, PeopleChain bridge production EOA | checklist §L3 |
| 3.6 | **Key hygiene scrub** — move ~13 hardcoded `scripts/*.ts` keys to gitignored `.env`; scrub git history; rotate/abandon any committed address; gitleaks/trufflehog in CI | checklist secrets |
| 3.7 | **Lock ladder** — `lockRelayerOpen`, curator locks, `raisePhaseFloor` after each phase transition; token-plane sunset readiness (do NOT fire issuer transfer pre-parachain) | checklist locks |
| 3.8 | **Production params + EIP-170** — EOA → Safe rotation, Timelock lengthening, SR_V1 3-of-5 threshold, treasury rotations; `npm run size:mainnet` revalidation | checklist |
| 3.9 | **Deploy** — Kusama canary → Polkadot Hub | all above |

**R3 exit:** mainnet live, audited, all locks fired per the cypherpunk ladder,
aggregation serving the high-volume lane (or explicitly deferred to a post-launch
ladder upgrade if R1.5 data argues against building it yet).

---

## Critical path & parallelism

- **Now:** R1.3, R1.5, R1.2, R1.4 (lab, no browser) ∥ R1.1 (Kasey, browser).
- **R1.5 is the long pole for the aggregation decision** — its compression-ratio
  + challenger-economics outputs gate R3.1. Run it first.
- **R2** can start once R1 proves the mechanism (the toolkit shouldn't harden a
  mechanism that isn't validated). R2.5 fee model waits on R1.2 cost data.
- **R3.3 audit** is the serialization point — everything contract-side (3.1, 3.2,
  3.5, 3.7) must be final before it starts; re-auditing churn is expensive.

## Immediate next action

Build **R1.5 (off-chain net-delta aggregator + compression measurement)** and
**R1.3 (indexer escrow/vault/token coverage)** in parallel — both pure lab work,
both feed the aggregation decision and the value-conservation proof, neither needs
the browser flow Kasey is verifying separately.
