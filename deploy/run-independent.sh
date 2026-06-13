#!/usr/bin/env bash
# Launch the independent publisher relay (frank, :3410) + advertiser co-signer
# (charlie, :3411) persistently, with HMAC auth. Secrets/keys come from the
# gitignored secrets.env. PIDs + logs land in this dir.
set -euo pipefail
cd "$(dirname "$0")"
source ./secrets.env

LAB="$(cd .. && pwd)"

echo "Starting advertiser co-signer (charlie) on :3411…"
( cd "$LAB/advertiser-cosigner" && \
  ADVERTISER_PRIVATE_KEY="$CHARLIE_KEY" COSIGN_SECRET="$COSIGN_SECRET" HTTP_PORT=3411 \
  nohup node src/server.mjs > "$LAB/deploy/cosigner.log" 2>&1 & echo $! > "$LAB/deploy/cosigner.pid" )

echo "Starting publisher relay (frank) on :3410…"
( cd "$LAB/relay" && \
  RELAY_PRIVATE_KEY="$FRANK_KEY" ADVERTISER_PRIVATE_KEY= \
  ADVERTISER_COSIGNER_URL=http://127.0.0.1:3411 ADVERTISER_COSIGNER_SECRET="$COSIGN_SECRET" \
  RELAY_HMAC_SECRET="$RELAY_HMAC_SECRET" HTTP_PORT=3410 CLAIM_BATCH_SIZE=1 MAX_INFLIGHT=25 LOG_LEVEL=1 \
  nohup node src/index.mjs > "$LAB/deploy/relay.log" 2>&1 & echo $! > "$LAB/deploy/relay.pid" )

sleep 5
echo "co-signer health: $(curl -s --max-time 4 localhost:3411/health || echo DOWN)"
echo "relay health:     $(curl -s --max-time 4 localhost:3410/health | head -c 80 || echo DOWN)"
echo
echo "PIDs: cosigner $(cat cosigner.pid), relay $(cat relay.pid)"
echo "Operator console (LOCAL only): http://127.0.0.1:${ADMIN_PORT:-3420}/dashboard"
echo "Testers POST /claim with X-Datum-Ts + X-Datum-Sig = HMAC-SHA256(RELAY_HMAC_SECRET, \"\${ts}.\${body}\")."
