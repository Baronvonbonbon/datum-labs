# DATUM lab relay

A standalone, pine-free relay for the lab. Receives clicks + signed claim
batches from the SDK/extension, **co-signs as the publisher's relay signer**, and
submits `recordClick` + `settleSignedClaims` on-chain so users pay zero gas. It's
a trimmed variant of `../../datum/relay-bot.example` (which depends on the
in-repo `pine` light client and leaves settlement as a Stage-7d stub).

This is the dependency the `../publisher-shortener` points its `RELAY_URL` at.

## What it does

| Endpoint | Purpose |
|---|---|
| `POST /click` | SDK click → batched → `DatumClickRegistry.recordClick` |
| `POST /claim` | extension `SignedClaimBatch` → co-sign → `DatumDualSigSettlement.settleSignedClaims` |
| `POST /withdraw` | user-signed `WithdrawAuth` → `DatumPaymentVault.withdrawUserBySig` (gasless withdrawal — **staged**) |
| `GET /withdraw-info?user=0x..` | nonce + withdrawable balance + vault, for building the signature |
| `GET /metrics` | counters (clicks/claims received/submitted, settled/rejected, withdraws) |
| `GET /health` | provider readiness + signer addresses |
| `GET /events?since=N` | recent event ring buffer (for a publisher dashboard) |
| `GET /bulletin/<cid>` | 501 (Bulletin gateway not wired in the lab) |

### Gasless withdrawal (staged — needs a vault upgrade)

A new user can earn (relay-submitted settlement, gas-free) but still needs gas to
*withdraw*. `/withdraw` closes that: the user signs an EIP-712 `WithdrawAuth`
off-chain (zero gas); the relay submits `DatumPaymentVault.withdrawUserBySig`, pays
the gas, and is reimbursed up to the user-signed `maxFee` out of the withdrawn
balance. Non-custodial — the relay can't exceed `maxFee`, redirect the net, or
replay (the contract enforces nonce + deadline + signer).

`withdrawUserBySig` is implemented + tested in `datum/alpha-core` but **not yet
deployed** (staged for the next `DatumPaymentVault` upgrade). Against the current
live vault the endpoint returns `vault-not-upgraded`. Test it once deployed:

```bash
npm run sign-withdraw -- --user-key 0x<balance owner key> --max-fee 1000000000
# (signs WithdrawAuth, POSTs to /withdraw; the user pays no gas)
```

## Run

```bash
npm install
cp .env.example .env     # set RELAY_PRIVATE_KEY (required)
npm start                # → http://127.0.0.1:3400
```

## The dual-sig settlement path (how it actually verifies)

`settleSignedClaims` lives on `DatumDualSigSettlement` and checks **two**
signatures over the same envelope:

```
claimsHash = keccak256(concat(claim.claimHash for each claim))
digest     = EIP-712("DatumSettlement","1", verifyingContract = dualSig) over
             ClaimBatch(user, campaignId, claimsHash, deadlineBlock,
                        expectedRelaySigner, expectedAdvertiserRelaySigner)
```

- **publisherSig** — recovered signer must equal the publisher's registered
  `relaySigner`. The relay holds that key, so it co-signs automatically. ⇒
  **`RELAY_PRIVATE_KEY`'s address must be set as the publisher's relay signer**
  via `DatumPublishers.setRelaySigner(...)`, or settlement reverts `E82/E84`.
- **advertiserSig** — recovered signer must equal the campaign's advertiser (or
  its advertiser relay signer). This is the dual-sig guarantee: the advertiser
  can refuse to sign. In a self-contained lab run where you control both sides,
  set `ADVERTISER_PRIVATE_KEY` so the relay co-signs both; otherwise the
  `advertiserSig` must arrive in the `POST /claim` body. Mismatch reverts `E83/E85`.

The relay fills the optional ZK / stake / PoW claim fields with zeros, so a plain
CPM claim settles without the ZK machinery.

## `/claim` envelope

```jsonc
{
  "user": "0x…",
  "campaignId": "42",
  "deadlineBlock": "9450000",
  "claims": [{ "campaignId":"42","publisher":"0x…","eventCount":"3",
               "ratePlanck":"2000000","claimHash":"0x…" /* + optional fields */ }],
  "userSig": "0x…",                 // produced by the extension (user's EIP-712 sig)
  "expectedRelaySigner": "0x…",     // optional; defaults to the relay address
  "publisherSig": "0x…",            // optional; relay co-signs if absent
  "advertiserSig": "0x…"            // optional; relay co-signs if ADVERTISER_PRIVATE_KEY set
}
```

## Known simplifications vs. production

- **Clicks have no user address** (the SDK doesn't send one), so — exactly like
  the canonical skeleton — the relay uses `publisher` as a stand-in and hashes a
  nonce. Real wiring joins clicks against the impression record from the claim queue.
- **No campaign poller.** `CAMPAIGN_ALLOWLIST` (empty = accept all) replaces the
  on-chain campaign-set sync. Fine for a controlled lab; a production relay only
  brokers its own publishers' campaigns.
- **In-memory queues** (no persistence) and **localhost bind** with no HMAC/TLS.

## Prove settlement without the extension

`scripts/inject-claim.mjs` builds a valid `SignedClaimBatch` (claimHash mirrors
`DatumClaimValidator`'s `abi.encode` preimage exactly) and POSTs it to `/claim`.
The relay co-signs + submits — so you can settle on-chain without wiring up the
browser extension.

```bash
node scripts/inject-claim.mjs --relay http://127.0.0.1:3410 \
   --campaign 158 --publisher 0xPUB --rate 2000000 --events 3
node scripts/inject-claim.mjs --campaign 158 --publisher 0xPUB --dump   # inspect, don't post
```

A fresh random `--user` each run keeps `nonce == 1` (no hash-chain bookkeeping).
Settlement still needs the on-chain prerequisites above. See the script header for all flags.

## Generate your own demand + traffic

- **`npm run create-campaign`** — stand up one fresh ACTIVE campaign (advertiser
  stake → createCampaign → admin activate). Needs `ADVERTISER_PRIVATE_KEY` (creator)
  and `ADMIN_PRIVATE_KEY` (the AdminGovernance governor) in `.env`.
- **`npm run load -- --campaigns 158,169 --users 20`** — fire N fresh users ×
  M campaigns at a *running* relay; only loads campaigns that are GO with the
  relay's keys.
- **`npm run load-returning -- --campaigns 158,169 --pool 50 --impressions 800`**
  — like `load`, but draws from a FIXED user pool with a skewed activity
  distribution (`--skew`, default Zipf 1.0) so distinct users ≪ claims. This is
  the realistic-market generator for the settlement-aggregation measurement:
  `load`'s fresh-per-claim users make `../indexer` `/api/aggregation` report
  `compressionVsClaims < 1` (worst case); returning users move it to the real
  ratio. `--seed S` makes the pool deterministic so the same users return across
  runs; `--dry` prints the planned distribution + predicted compression without
  posting. One `nonce=1` claim per (user,campaign) pair (independent chains —
  no nonce-race), with `eventCount` = impressions that landed on the pair.
- **`npm run topup`** — master-EOA funding loop (R1 decision 6a). Faucet ONE
  master EOA generously (`MASTER_PRIVATE_KEY` in `.env`); this keeps the
  gas-spending EOAs (relay/advertiser/admin, derived from the `.env` keys) topped
  up during a load run so the fleet never stalls on an empty account. `--once`
  for a single pre-run pass, `--dry` to preview, `--targets` to fund explicit
  addresses. Warns loudly when the master itself runs low (the cue to re-faucet).
  Note the Paseo unit quirk it handles: `eth_getBalance` is 18-decimal wei but tx
  `value` is 10-decimal planck.
- **`npm run scenario -- --campaigns 3 --users 5`** — turnkey liquidity-curve demo:
  creates K campaigns, spins up the relay itself, drives the load, then prints the
  whole-market **before → after** delta from `../indexer` (campaigns, settlements,
  uniqueUsers, liquidityRatio, fill rate).

> Paseo note: keep `CLAIM_BATCH_SIZE=1`. The dual-sig path is heavy enough that
> `settleSignedClaims` hits the per-tx weight cap at 2-3 batches (bare revert).

### Settlement throughput (pipelined)

The relay pipelines settlement txs instead of send→confirm→send. `_pump` fires up
to `MAX_INFLIGHT` (default 25) txs with manually-managed nonces and never blocks
the queue on confirmation; `estimateGas` gates each send so a reverting claim
never burns a nonce. `_reconcile` resolves in-flight txs (receipt **or**
nonce-advance, per the Paseo receipt-null bug) and resubmits any stuck past
`SETTLE_STUCK_MS`. Measured: **~13 → ~65 settlements/min** from one signer (~5×).

Next lever (not built): `settleSignedClaims` is permissionless (no `msg.sender`
check), so a **submitter pool** of N gas-payer EOAs can broadcast the single
relaySigner's off-chain signatures in parallel — scaling even a single publisher.

## End-to-end in the lab

1. Register the publisher and set its relay signer to this relay's address.
2. `npm start` here; point `publisher-shortener`'s `RELAY_URL` at `http://127.0.0.1:3400`.
3. Visit short links with the extension → claims/clicks flow here → settle on-chain.
4. Watch `../indexer` for the new `ClaimSettled` / `ClickRecorded` events.
