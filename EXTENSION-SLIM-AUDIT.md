# Extension/SDK SLIM-correctness audit (A2 prep)

**Date:** 2026-06-13. **Scope:** does the browser extension's claim path build the
current **SLIM** wire format the deployed contracts + the (ported) relay/cosigner
expect, so a *real user* can earn end-to-end? Companion to the relay/cosigner SLIM
port (datum-labs PR #2) and the dualSig v2 / E89 upgrade (datum PR #25/#26).

## TL;DR — ✅ the extension is SLIM-correct. No extension code changes needed.

The extension's claim construction and **both** on-chain submission paths produce
the current SLIM format, byte-aligned with the contracts and the ported relay
(independently verified: the relay's `CLAIM_TUPLE` encoding is identical to the
extension's `SLIM_CLAIM_TUPLE`). What's missing for a live "real user earns" demo
is **wiring/config + a path choice**, not correctness — see Gaps.

## What was verified

### 1. Claim construction — `src/background/claimCore.ts` (single source of truth) ✅
- `computeClaimHash` = the on-chain `computedHash` 10-field `abi.encode` preimage
  (`campaignId, publisher, user, eventCount, rateWei, actionType, clickSessionHash,
  nonce, previousClaimHash, stakeRootUsed`) — matches `DatumClaimValidator`.
- `toSlimClaim` / `packProof` → SLIM `Claim` `(publisher, eventCount, rateWei,
  actionType, ClaimProof[] proof)`; `proof = []` for a plain all-zero view claim
  (matches the contract's `hasProof` logic).
- `SLIM_CLAIM_TUPLE` and `contentHashClaims` (`keccak(concat(keccak(abi.encode(
  slimClaim))))`) match `DatumDualSigSettlement._hashClaims` **and** the relay's
  `computeClaimsHash` byte-for-byte.
- `claimBuilder.ts` maintains per-(user,campaign,actionType) chain state
  (`lastNonce`, `lastClaimHash`) — so `firstNonce` and `prevHash` are correct,
  including for returning users.

### 2. Path A — background auto-flush → `settleClaimsAttested` (`index.ts`) ✅ SLIM, ⚠️ user-pays-gas
- Builds `AttestedBatch{user, campaignId, firstNonce, claims:slim[], deadlineBlock,
  publisherSig}`; solves PoW **before** building slim claims so the cosigned
  `claimsHash` matches what's submitted; `firstNonce = claims[0].nonce`.
- On-chain `DatumAttestationVerifier` is **deployed** (`0xCCA37672489D0b023B3aaDb338E3474E3E4D4fd4`)
  and SLIM: `AttestedBatch` has `firstNonce`; `PUBLISHER_ATTESTATION_TYPEHASH`
  includes `firstNonce`, matching `requestPublisherAttestation`'s body.
- **Constraint:** `require(msg.sender == ab.user)` → the **user submits and pays
  gas**, and it needs a publisher attestation from `https://<dom>/.well-known/datum-attest`.

### 3. Path B — popup "submit via relay" → relay `/claim` → `settleSignedClaims` (`ClaimQueue.tsx`) ✅ SLIM, gasless
- EIP-712 `ClaimBatch` type includes `firstNonce`; `expectedRelaySigner =
  relaySigner(publisher)` on-chain (correct — the relay co-signs, not the
  publisher EOA); `expectedAdvertiserRelaySigner = 0` (advertiser self-signs via
  its cosigner EOA). Solves PoW per claim, then `toSlimClaim` + `contentHashClaims`.
- POSTs `claims = normalizeClaimForRelay(...)` which **also** goes through
  `toSlimClaim` → the `proof` sidecar is byte-identical to what `claimsHash`
  signed, so the relay's recomputed `claimsHash` matches (no E82/E83).
- **This is the gasless path** (relay pays gas, advertiser cosigner refutes) — the
  same envelope shape proven working by the live `inject` test. Best fit for an
  open beta where users hold no PAS.

### 4. Publisher relay discovery — `router.ts SET_PUBLISHER_RELAY` ✅
- The publisher's page (DATUM SDK) tells the extension its relay domain; cached as
  `publisherDomain:<addr>` (validated HTTPS + sender-tab-domain must match relay
  domain → anti-hijack). Both paths read it.

## Gaps for a live "real user earns" E2E (wiring, not bugs)

1. **`publisherDomain` needs a real publisher page running the SDK** pointing at
   `relay.javcon.io`, or a manual seed in the extension. There is no live
   SDK-instrumented publisher page wired to a real campaign yet.
2. **Pick the beta settlement path.** For an **open beta with users who hold no
   PAS**, Path B (relay dual-sig, gasless) is the one to use. Path A
   (`settleClaimsAttested`) requires the user to hold gas **and** a
   `/.well-known/datum-attest` endpoint the datum-labs relay does **not** serve.
3. **Default-path mismatch:** the *background auto-flush* defaults to Path A
   (user-pays-gas); the gasless relay path is a *manual* popup action. For a
   gasless beta this is backwards — either default auto-flush to the relay path,
   or have a relay submit `settleClaimsAttested` on users' behalf. **Product
   decision before opening the beta.**

## Recommended next step for the live A2 proof
Stand up one SDK-instrumented publisher page (or seed `publisherDomain`), connect a
real wallet in the extension, generate one impression, and flush via the **relay
path** → confirm it settles gaslessly through diana→bob-cosigner→`dualSig v2`
(same path already proven by `inject`). Decide the auto-flush default (#3) as part
of it. A Playwright + unpacked-extension harness can automate this if a manual
browser run isn't preferred.
