# DATUM advertiser co-signer

The independent **advertiser** half of dual-sig settlement. Holds **only** the
advertiser's key. The publisher relay POSTs batch envelopes here; this service
independently decides whether to sign (it owns the campaign, the rate is within
policy) and returns `advertiserSig` — or refuses.

This restores the guarantee the lab's all-in-one relay defeated: with the
advertiser key living *inside* the publisher's relay, the publisher could forge
the advertiser's consent. Split out, it can't.

## Run

```bash
npm install
cp .env.example .env   # set ADVERTISER_PRIVATE_KEY (the advertiser, or its registered advertiser-relay-signer)
npm start              # → http://127.0.0.1:3411
```

## API

- `POST /cosign` — body `{ user, campaignId, deadlineBlock, expectedRelaySigner,
  expectedAdvertiserRelaySigner, claims:[{claimHash, ratePlanck}] }`.
  Returns `{ ok:true, advertiserSig, signer }` or `403 { ok:false, reason }`.
  Checks: campaign allowlist (optional), **campaign ownership** (the campaign's
  on-chain advertiser must equal this key / its advertiser-relay-signer), and an
  optional `MAX_CPM_PLANCK` rate cap. Recomputes `claimsHash` itself — never trusts
  a caller-supplied digest.
- `GET /health`, `GET /metrics` (cosignRequests / cosigned / refused / errors).

## How the publisher relay uses it

Run the relay with `ADVERTISER_COSIGNER_URL=http://127.0.0.1:3411` and **no**
`ADVERTISER_PRIVATE_KEY`. When a claim's `advertiserSig` is missing, the relay
POSTs here; a refusal means the claim is dropped (`advertiser-cosigner-refused`).

## Verified (2026-05-29, controlled round-trip)

Publisher relay (frank, `:3410`, no advertiser key) + this co-signer (charlie,
`:3411`) settled campaign 184 on-chain end-to-end. The co-signer **signed** for
campaign 184 (charlie's) and **refused** campaign 158 (bob's). Neither service
holds the other's key.

## Policy knobs (the advertiser's independent acceptance rules)

`CAMPAIGN_ALLOWLIST` (only these ids), `MAX_CPM_PLANCK` (refuse overpriced claims).
A real advertiser would extend `cosign()` with budget pacing, fraud signals, etc.
