# Infra resilience — single-host today, VPS migration runbook

The DATUM relay fleet currently runs as **user systemd services on one laptop**
behind a Cloudflare tunnel. systemd auto-restarts crashed processes and
`datum-monitor` makes outages visible (alerts → ntfy), but a **laptop reboot,
sleep, or network drop = full outage**. For an open public beta, move the fleet to
an always-on host. The services are already portable — this is mostly copy + run.

## What's running (single host)

| service | role | port | tunnel |
|---|---|---|---|
| `datum-relay@diana` / `@frank` | publisher relays | 3400 / 3410 | diana → `relay.javcon.io` |
| `datum-cosigner@bob` / `@charlie` | advertiser co-signers | 3402 / 3411 | charlie → adv host |
| `datum-monitor` | fleet monitor (/metrics, alerts) | 3500 (local) | — |
| `datum-topup` | gas auto-topup (master → submitters) | — | — |
| `datum-ipfs` + `datum-ipfs-proxy` | creative hosting | 5050 | ipfs host |
| `datum-cloudflare-tunnel` | Cloudflare tunnel | — | — |

## What's stateful (must move / re-create)

- **Secrets:** `~/.config/datum-relay/*.env` (relay/cosigner keys, `topup.env` master
  key, `monitor.env` webhook). chmod 600. **The only thing that's irreplaceable** —
  back these up encrypted.
- **Policy:** `~/.config/datum-relay/<inst>.config.json` (per-relay publisher/campaign
  allowlists).
- **Cloudflare tunnel creds** (`~/.cloudflared/` + the tunnel config).
- **Indexer DB** (`datum-labs/indexer/data/datum.db`) — disposable; `npm run backfill`
  rebuilds it from chain.
- **Chain state** (nonces, balances, campaigns) — all on-chain; nothing to migrate.
- **The repos** (`datum`, `datum-labs`) — `git clone`.

## VPS migration (≈30 min)

1. **Provision** a small always-on Linux VPS (1–2 vCPU / 2–4 GB is plenty; the relay
   is light). Any provider.
2. **Base:** install Node 22 (match `fnm`/the version in the systemd units), git,
   build tools (`better-sqlite3` for the indexer compiles).
3. **Clone:** `git clone` both `datum` and `datum-labs` to `~/Documents/` (the unit
   `WorkingDirectory` paths assume `%h/Documents/...` — keep them or edit the units).
   `npm ci` in `relay/`, `advertiser-cosigner/`, `indexer/`.
4. **Install units:** `cd datum-labs/deploy/systemd && ./install.sh` (substitutes the
   node path, installs all units, enables linger so they run without a login session).
5. **Secrets:** copy `~/.config/datum-relay/*.env` + `*.config.json` from the laptop
   (over SSH, chmod 600). **Never commit these.** Set `ADVERTISER_PRIVATE_KEY=` (empty)
   in relay env files so a stray `relay/.env` can't leak a key (see systemd README).
6. **Tunnel:** copy the cloudflared creds + config, repoint the `relay.javcon.io`
   (etc.) DNS routes to the new tunnel. Keep the tunnel→relay dependency `Wants=`, never
   `Requires=` (a hard cascade kills the tunnel on relay restart — see systemd README).
7. **Enable:** `systemctl --user enable --now datum-cosigner@{bob,charlie}
   datum-relay@{diana,frank} datum-monitor datum-topup` and (if hosting) the IPFS units.
8. **Verify:** `curl 127.0.0.1:3500/health` (monitor: all up, issues=[]),
   `curl https://relay.javcon.io/health`, fire a test claim (`relay/scripts/inject-claim.mjs`).
9. **Decommission** the laptop services (`systemctl --user disable --now datum-*`) once
   the VPS is serving, so two fleets don't double-submit.

## Cheaper interim hardening (no migration)

- **Keep the laptop awake + online:** disable sleep/suspend (`systemctl mask
  sleep.target suspend.target`), wire ethernet, UPS if possible.
- **Auto-start on boot:** linger is already enabled (`loginctl enable-linger`), so the
  user services come up after a reboot without a login.
- **Watchdog:** `datum-monitor` already alerts on down services / chain stall / low gas
  → make sure the ntfy topic is subscribed on your phone so you hear about outages.

## Containerization — one-command deploy (`deploy/docker/`)

A full `docker compose` stack is now built (`deploy/docker/`): relay×2,
cosigner×2, monitor, topup, indexer (run + API) + an optional cloudflared sidecar,
self-contained via `DATUM_GOVERNANCE_ROUTER` (no sibling datum repo needed). For a
VPS move, this replaces steps 3–7 above with:

```bash
cd datum-labs/deploy/docker
for f in env/*.env.example; do cp "$f" "env/$(basename "$f" .example)"; done
chmod 600 env/*.env            # then fill in the private keys
docker compose up -d --build
```

See `deploy/docker/README.md`. The systemd units remain the current production
source of truth; the compose is the portable/disposable-host alternative.
