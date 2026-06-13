# Exposing the independent relay + co-signer via Cloudflare

Two local services from the controlled round-trip (verified 2026-05-29):

| service | local | role |
|---|---|---|
| publisher relay | `127.0.0.1:3410` | frank's relay (holds frank key only; calls the co-signer) |
| advertiser co-signer | `127.0.0.1:3411` | charlie's co-signer (holds charlie key only) |

Diana's tunnel today (`~/.cloudflared/config.yml`, tunnel `datum-relay`
`<tunnel-uuid>`): `relay.example.com → :3400`, plus the IPFS hosts.

> ⚠️ **Read before exposing publicly.** The publisher relay's `POST /claim` has
> **no auth** — anyone who can reach it can make frank pay gas for arbitrary
> claims (griefing/DoS). This is roadmap item **A3**. Keep these on **localhost**
> for controlled testing; before "bringing in others," add HMAC auth + rate-limit
> (and ideally mTLS via Cloudflare Access), or only expose to a trusted allowlist.
> The co-signer is safer (it refuses non-charlie campaigns) but is still spammable.

---

## Option A — add to the existing `datum-relay` tunnel (shared)

**Do NOT hand-edit + restart blind** — back up first; a typo drops Diana.

1. Back up: `cp ~/.cloudflared/config.yml ~/.cloudflared/config.yml.bak`
2. Insert these ingress rules **above** the final `- service: http_status:404`:

```yaml
  # DATUM lab — independent publisher relay (frank)
  - hostname: pub-relay.example.com
    service: http://127.0.0.1:3410
  # DATUM lab — independent advertiser co-signer (charlie)
  - hostname: adv-cosign.example.com
    service: http://127.0.0.1:3411
```

3. Create DNS (CNAME → tunnel) for each host — needs your Cloudflare creds
   (`~/.cloudflared/cert.pem` already present):

```bash
cloudflared tunnel route dns datum-relay pub-relay.example.com
cloudflared tunnel route dns datum-relay adv-cosign.example.com
```

4. Reload the tunnel via **systemd** (this briefly reconnects Diana too):
   `systemctl --user restart datum-cloudflare-tunnel.service`
   ⚠️ **Do NOT `kill -HUP` cloudflared** — this version (2026.3.0) *terminates* on
   SIGHUP rather than reloading, dropping Diana until systemd's `Restart=on-failure`
   catches it. The tunnel is the user unit **`datum-cloudflare-tunnel.service`**
   (enabled, Restart=on-failure); always manage it through systemctl. Rollback: the
   live config was backed up to `~/.cloudflared/config.yml.bak`.

The ready-to-paste full file is `config.yml.shared-proposed` in this dir — diff it
against your live config before applying.

---

## Option B — separate tunnels you provide

If you'd rather isolate these from Diana's tunnel, give me one of:
- a **tunnel token** per service (`cloudflared tunnel run --token …`), or
- a named tunnel + hostnames you've pre-routed.

Then each service runs behind its own `cloudflared` with a one-line ingress
(`service: http://127.0.0.1:3410` / `:3411`). Templates: `tunnel-pub-relay.yml`,
`tunnel-adv-cosign.yml` in this dir.

---

## Running the two services (the verified controlled setup)

```bash
# advertiser co-signer (charlie) — its .env already holds charlie's key
cd advertiser-cosigner && npm start                       # :3411

# publisher relay (frank) — override to use frank + the co-signer, no advertiser key
cd relay && RELAY_PRIVATE_KEY=<frank> ADVERTISER_PRIVATE_KEY= \
  ADVERTISER_COSIGNER_URL=http://127.0.0.1:3411 HTTP_PORT=3410 CLAIM_BATCH_SIZE=1 npm start   # :3410

# smoke test the round-trip
cd relay && node scripts/inject-claim.mjs --relay http://127.0.0.1:3410 \
  --campaign 184 --publisher <frank>
```

(For a persistent setup, drop those overrides into a dedicated `relay/.env.frank`
and load it, rather than env-on-the-command-line.)
