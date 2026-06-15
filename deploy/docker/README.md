# DATUM fleet — Docker Compose deploy

One-command stand-up of the whole relay fleet on a fresh host (the VPS target in
`../RESILIENCE.md`): 2 relays, 2 advertiser co-signers, the fleet monitor, gas
auto-topup, and the indexer (run + API) — plus an optional Cloudflare tunnel.

**Self-contained:** every service resolves contract addresses from the on-chain
registry via `DATUM_GOVERNANCE_ROUTER`, so the sibling `datum` repo is **not**
needed. Services reach each other by name on the `datum` network (the relay calls
`http://cosigner-bob:3402`, the monitor scrapes `http://relay-diana:3400`, …).

## Quick start

```bash
cd datum-labs/deploy/docker

# 1. Fill secrets (private keys) — one .env per service, chmod 600. Templates:
for f in env/*.env.example; do cp "$f" "env/$(basename "$f" .example)"; done
chmod 600 env/*.env
$EDITOR env/relay-diana.env      # RELAY_PRIVATE_KEY (diana)
$EDITOR env/relay-frank.env      # RELAY_PRIVATE_KEY (frank)
$EDITOR env/cosigner-bob.env     # ADVERTISER_PRIVATE_KEY (bob)
$EDITOR env/cosigner-charlie.env # ADVERTISER_PRIVATE_KEY (charlie)
$EDITOR env/topup.env            # MASTER_PRIVATE_KEY (faucet-funded)
$EDITOR env/monitor.env          # ALERT_WEBHOOK (optional ntfy/Slack)
# env/indexer.env works as-is.

# 2. (optional) edit per-relay publisher policy
$EDITOR config/diana.config.json config/frank.config.json

# 3. Build + run
docker compose up -d --build
docker compose ps
docker compose logs -f relay-diana
```

## Verify

```bash
curl -s 127.0.0.1:3500/health | jq          # monitor: all up, issues=[]
curl -s 127.0.0.1:4319/api/aggregation | jq # indexer metrics
docker compose exec relay-diana node scripts/inject-claim.mjs \
  --campaign <id> --publisher <diana> --relay http://localhost:3400   # smoke test
```

## Cloudflare tunnel (public hostnames)

The relays bind `0.0.0.0` **inside the docker network only** — no host ports. To
serve them publicly, uncomment the `cloudflared` service in `docker-compose.yml`,
put a named-tunnel `TUNNEL_TOKEN` in `env/cloudflared.env`, and point the
dashboard ingress at `http://relay-diana:3400` (and the co-signer/relay hosts as
needed). Keep the tunnel a sidecar on the `datum` network so it resolves the
service names. (Per-IP rate-limiting uses Cloudflare's `cf-connecting-ip`, so
abuse controls still see the real client.)

## Notes

- **Secrets** live only in `env/*.env` (gitignored). `*.env.example` + `config/*.json`
  are the tracked templates.
- **Relays are not self-cosign:** `ADVERTISER_PRIVATE_KEY` is empty and the
  co-signers are wired via `ADVERTISER_COSIGNERS`, so dual-sig independence holds
  (a relay cannot sign the advertiser side). `RELAY_PUBLIC=1` is set because the
  tunnel exposes them.
- **Gas topup** idles unless a submitter drops below 50 PAS; faucet the master in
  `env/topup.env` and watch the log for low-master warnings.
- **Indexer** `run` continuously backfills+tails into the `indexer-data` volume;
  `indexer-api` serves `/api/*` from the same volume.
- Updates: `git pull && docker compose up -d --build`.
- **Untested here:** authored without a Docker daemon available — validate with
  `docker compose config` and a first `up --build` on the target host.
