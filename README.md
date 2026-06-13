# DATUM Labs

A test bench for the DATUM ad exchange (Paseo Hub, alpha-core). Lightweight services
deployed *against the live network* to generate real on-chain activity and measure
network effects. **Deliberately outside the `datum` git tree** — nothing here ships
with the protocol.

See [`BRAINSTORM.md`](./BRAINSTORM.md) for the full idea backlog and the metric
definitions, [`ROADMAP.md`](./ROADMAP.md) for the gap analysis between this tooling
and a viable real market, and [`RELAY-TOOLKIT-SCOPE.md`](./RELAY-TOOLKIT-SCOPE.md)
for the self-deployable relay toolset scope. This README is the run order for what's built.

## Contract addresses (env-first, registry-resolved)

Every service resolves contract addresses the same way (`src/registry.{mjs,js}`):

1. **Router (canonical):** set `DATUM_GOVERNANCE_ROUTER` (+ `RPC_URL`) and each contract
   is read **live** from the on-chain `DatumGovernanceRouter` registry via
   `currentAddrOf(keccak256(name))`. This auto-tracks governance upgrades, and makes a
   service **self-contained in production** — no sibling `datum` repo required.
2. **Seed file (fallback):** `DATUM_ADDRESSES` (default
   `../../datum/alpha-core/deployed-addresses.json`) supplies the router address when
   `DATUM_GOVERNANCE_ROUTER` is unset, and is the per-slot fallback whenever the registry
   returns zero for a slot or the chain can't be reached.

On startup each service logs whether addresses came from `router` or the static file, and
warns if the configured router returns no address for a core slot (`campaigns`/`settlement`/
`publishers`) — the reliable "wrong/old router" signal.

## The loop

```
 publisher-shortener ──impressions/clicks──► relay ──recordClick / settleSignedClaims──► chain
       (supply)                          (co-sign + pay gas)                               │
                                                                                           ▼
                                                                                        indexer
                                                                                  (whole-market metrics)
```

| Tool | Role | Status |
|---|---|---|
| [`indexer/`](./indexer) | Persistent whole-market event indexer + metrics API/dashboard | ✅ built & verified (439 live logs) |
| [`publisher-shortener/`](./publisher-shortener) | Tier-1 publisher: ad-supported URL shortener (supply) | ✅ built & verified |
| [`relay/`](./relay) | Click + dual-sig settlement broker (co-signs, pays gas) | ✅ built & verified |
| [`relay/scripts/inject-claim.mjs`](./relay/scripts/inject-claim.mjs) | Synthetic claim injector — settle without the extension | ✅ built & verified |

## Run order (full end-to-end)

```bash
# 1. Indexer — start measuring (one shell each).
cd indexer && npm install && npm start        # backfill + tail → data/datum.db
cd indexer && npm run serve                    # → http://localhost:4319

# 2. Relay — the settlement broker. Set HTTP_PORT to avoid the Diana relay on 3400.
cd relay && npm install && cp .env.example .env
#   RELAY_PRIVATE_KEY      = the publisher's key (self-sign path) or its relay signer
#   ADVERTISER_PRIVATE_KEY = the campaign advertiser's key (lab convenience)
HTTP_PORT=3410 npm start                       # → http://127.0.0.1:3410

# 3a. Prove settlement WITHOUT a browser — inject a synthetic claim:
cd relay && node scripts/inject-claim.mjs \
   --relay http://127.0.0.1:3410 --campaign <ID> --publisher <0xPUB> --rate <PLANCK>
#   → relay co-signs + submits settleSignedClaims; watch indexer for ClaimSettled.

# 3b. OR drive real traffic — point the publisher at the relay:
cd publisher-shortener && npm install && cp .env.example .env
#   PUBLISHER_ADDRESS=<0xPUB>  RELAY_URL=http://127.0.0.1:3410
npm start                                      # → http://localhost:4320, visit links w/ the extension
```

## On-chain prerequisites for real settlement

The injector and publisher build *valid* claims, but the chain still enforces:
1. **Publisher registered** (`DatumPublishers`) and staked.
2. **Relay authorized** — `RELAY_PRIVATE_KEY`'s address is the publisher's
   `relaySigner`, OR use the self-sign path (`--expected-relay 0x0`, relay key = publisher key).
3. **Advertiser sig** — `ADVERTISER_PRIVATE_KEY` = the campaign's advertiser
   (self-sign), or its registered advertiser relay signer.
4. **Campaign active**, `ratePlanck` ≤ its bid CPM, relay funded with PAS for gas.

Each tool's README has the contract-level detail (error codes E81–E85, etc.).

## What the lab already revealed

The indexer's first run on live data: **166 active campaigns vs 3 publishers**
(liquidity ratio 55, campaigns spending ~4% of budget) — a supply-starved market.
The shortener + relay exist to add the missing supply side and watch the ratio move.
