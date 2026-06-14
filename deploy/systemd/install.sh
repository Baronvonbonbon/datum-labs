#!/usr/bin/env bash
# Install the DATUM relay/co-signer systemd USER units (templated, multi-instance).
# Detects node, substitutes it into ExecStart, and sets up the config dir.
set -euo pipefail
cd "$(dirname "$0")"

NODE="$(command -v node || true)"
[ -z "$NODE" ] && { echo "node not found on PATH"; exit 1; }
NODE="$(readlink -f "$NODE")"
echo "Using node: $NODE"

UNIT_DIR="$HOME/.config/systemd/user"
CFG_DIR="$HOME/.config/datum-relay"
mkdir -p "$UNIT_DIR" "$CFG_DIR"

for t in datum-relay@.service datum-cosigner@.service datum-monitor.service datum-topup.service; do
  sed "s|__NODE__|$NODE|" "$t" > "$UNIT_DIR/$t"
  echo "installed $UNIT_DIR/$t"
done
systemctl --user daemon-reload

# Boot-persistence: user units run without an active login session.
loginctl enable-linger "$USER" 2>/dev/null || true

cat <<EOF

Done. Next:
  1. Create per-instance env files in $CFG_DIR/ (chmod 600), e.g. diana.env, bob.env.
     Templates: relay.env.example, cosigner.env.example (in this dir).
  2. Create policy configs, e.g. $CFG_DIR/diana.config.json
     ({ publishers:[], campaigns:[], signing:{ mode:"auto" } }).
  3. Enable + start instances:
       systemctl --user enable --now datum-cosigner@bob
       systemctl --user enable --now datum-relay@diana
  4. Operator console (LOCAL): http://127.0.0.1:<ADMIN_PORT>/dashboard
  5. Fleet monitor (read-only; /metrics + /health on 127.0.0.1:3500, alerts):
       systemctl --user enable --now datum-monitor
     (optional config: $CFG_DIR/monitor.env from monitor.env.example)
  6. Gas auto-topup (refills relay submitters from a faucet-funded master):
       cp monitor.env.example/topup.env.example $CFG_DIR/topup.env  # set MASTER_PRIVATE_KEY (chmod 600)
       systemctl --user enable --now datum-topup

If a Cloudflare tunnel fronts a relay, depend on it with **Wants=** (soft), never
Requires= — a hard Requires cascade-kills the tunnel when the relay restarts.
EOF
