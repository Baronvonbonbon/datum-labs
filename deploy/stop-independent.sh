#!/usr/bin/env bash
# Stop the independent relay + co-signer started by run-independent.sh.
cd "$(dirname "$0")"
for svc in relay cosigner; do
  if [ -f "$svc.pid" ]; then
    pid=$(cat "$svc.pid")
    kill "$pid" 2>/dev/null && echo "stopped $svc (pid $pid)" || echo "$svc (pid $pid) not running"
    rm -f "$svc.pid"
  fi
done
# Wait for the ports to actually release (graceful shutdown holds them ~2s),
# so an immediate run-independent.sh doesn't hit EADDRINUSE.
for p in 3410 3411; do
  for _ in $(seq 1 10); do
    curl -s --max-time 1 "localhost:$p/health" >/dev/null 2>&1 || break
    sleep 0.5
  done
done
