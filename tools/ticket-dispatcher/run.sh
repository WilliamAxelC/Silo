#!/bin/bash
# Keeps the Silo ticket dispatcher running (no systemd user session on orca). Started by cron @reboot.
cd "$(dirname "$0")"
exec 9>"$HOME/.local/share/silo-tickets/run.lock"
flock -n 9 || { echo "already running"; exit 0; }
while true; do
  python3 dispatcher.py run >> "$HOME/.local/share/silo-tickets/logs/service.log" 2>&1
  sleep 10
done
