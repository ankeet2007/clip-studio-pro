#!/usr/bin/env bash
gh codespace stop -c glorious-telegram-jrj9wgv4jjw4fp9pp
# Log the OFF time for the `usage` command.
printf 'off %s\n' "$(date +%s)" >> "$HOME/cloud-usage.log"
echo "[cloud-off] codespace stopped. Phone auto-falls back to LOCAL rendering."
