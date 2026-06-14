# systemd units for the DATUM relay toolkit

Boot-persistent, multi-instance, auto-restarting user services for the relay +
advertiser co-signer. Replaces the `nohup` `run-independent.sh` for real deployments.

## Install

```bash
./install.sh        # detects node, installs templated units, enables linger
```

Then per instance, create `~/.config/datum-relay/<name>.env` (chmod 600) from the
`*.env.example` templates, a `<name>.config.json` policy file, and:

```bash
systemctl --user enable --now datum-cosigner@bob       # advertiser co-signer
systemctl --user enable --now datum-relay@diana        # publisher relay
journalctl --user -u datum-relay@diana -f              # logs
```

## Instances live here today

| unit | role | public port | admin (local) |
|---|---|---|---|
| `datum-relay@diana` | publisher relay (upgraded from legacy relay-bot) | 3400 → relay.example.com | 3401 |
| `datum-relay@frank` | publisher relay (independent dual-sig demo) | 3410 → pub-relay.example.com | 3420 |
| `datum-cosigner@bob` | advertiser co-signer for diana's campaigns | 3402 | — |
| `datum-cosigner@charlie` | advertiser co-signer for frank's campaigns | 3411 → adv-cosign.example.com | — |
| `datum-monitor` | fleet monitor — polls all of the above + chain + submitter gas; Prometheus `/metrics`, `/health`, state-change alerts (log + optional webhook) | 3500 (local) | — |
| `datum-topup` | gas auto-topup — refills relay submitters from a faucet-funded master when low (needs `topup.env` with `MASTER_PRIVATE_KEY`) | — | — |

### Monitor alerts

`datum-monitor` fires FIRING/RESOLVED edges (never per-cycle spam) for: a relay or
co-signer down/unhealthy, **co-signer down (dual-sig can't complete)**, submitter
gas below `MIN_GAS_PAS`, relay queue backlog, a spike in `claimErrors`, and the
chain not advancing. Set `ALERT_WEBHOOK` in `monitor.env` for a JSON `{text}` sink
(Slack / ntfy / Discord-slack); otherwise alerts go to the journal
(`journalctl --user -u datum-monitor -f`). Scrape `127.0.0.1:3500/metrics` with
Prometheus for graphs.

## Hard-won operational notes

- **Cloudflare dependency must be `Wants=`, not `Requires=`.** The legacy tunnel unit
  had `Requires=datum-relay-bot.service`; every relay restart cascade-killed the tunnel.
  The live tunnel unit was repointed to `Wants=datum-relay@diana.service` + a
  `Restart=always` drop-in so it self-heals.
- **Never `fuser -k <port>/tcp`** to free a relay port — it also kills *clients
  connected to* that port, including cloudflared's proxy connection, taking the
  tunnel down. Use `systemctl stop` / saved PIDs.
- **Set `ADVERTISER_PRIVATE_KEY=` (empty)** in relay env files: the relay's
  `dotenv` loads a stray `relay/.env` from its working dir, which can leak a lab
  advertiser key and silently bypass the independent co-signer.
- Restart races (EADDRINUSE) disappear under systemd — it serializes stop→start.
