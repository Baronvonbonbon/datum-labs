# datum.link — Tier-1 publisher (ad-supported URL shortener)

The canonical high-impression-density DATUM publisher. Visitors hit a short link,
see a 5-second interstitial carrying a **DATUM ad slot**, then redirect to the
target. Every redirect is an impression — so a handful of links generates the
settlement volume needed to stress-test the network and move the supply side of
the liquidity ratio.

```
short link  ──►  interstitial (DATUM ad slot + 5s dwell)  ──►  destination
                       │
                       └─ extension runs the auction, builds a claim,
                          relay co-signs + submits settlement on-chain
```

## Run

```bash
npm install
cp .env.example .env     # set PUBLISHER_ADDRESS + RELAY_URL for real fills
npm start                # → http://localhost:4320
```

Create a link on the home page, open it, and (with the DATUM extension installed
and a registered publisher) the slot fills and settles. The standalone
`../indexer` will then show new `ClaimSettled` events and a rising publisher count.

## Make fills real (3 prerequisites)

1. **Register the publisher.** `PUBLISHER_ADDRESS` must be registered in
   `DatumPublishers` (sets a take rate, emits `PublisherRegistered`). Do it via the
   webapp publisher page or a `register()` call against the alpha-core deploy.
2. **Run a relay.** `cp -r ../../datum/relay-bot.example ../../datum/relay-bot`,
   fill `.env`, `node src/index.mjs`. Point `RELAY_URL` at it. The relay co-signs
   claims and submits `DatumSettlement.settleSignedClaims` so users pay zero gas.
3. **Have demand.** The currently-seeded campaigns target `topic:crypto-web3` —
   the default `TAGS` already match. Tune `TAGS` to whatever campaigns are live.

Without these, the page still loads and renders the SDK's **house-ad fallback**
(useful for UI testing), but no auction/settlement happens and the indexer sees
nothing.

## How it plugs into DATUM

- Serves the real SDK from `../../datum/sdk/datum-sdk.js` at `/datum-sdk.js`
  (same-origin), configured via the documented `data-*` attributes.
- `data-relay-mode` selects the settlement path (`publisher` / `dualsig` /
  `datumrelay`) — flip it to A/B the three architectures (brainstorm probe 4.4).
- Clicks on the ad creative are detected by the extension, which fires
  `datum:click`; the SDK forwards to `${RELAY_URL}/click` → `DatumClickRegistry`.
  The shortener doesn't fake clicks.

## Telemetry

- `GET /api/links` — links + hit counts (hits ≈ interstitial impressions served;
  compare against `ClaimSettled` in the indexer to see fill rate for *this* publisher).
- Append `?datum-dev=1` to an interstitial URL for the SDK's inline dev panel.

## Knobs (`.env`)

`PUBLISHER_ADDRESS` · `RELAY_URL` · `RELAY_MODE` · `TAGS` · `SLOT` ·
`INTERSTITIAL_SECONDS` · `SDK_PATH` · `PORT`
