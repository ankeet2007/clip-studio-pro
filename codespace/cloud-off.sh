#!/usr/bin/env bash
gh codespace stop -c super-duper-capybara-wvrxj4p9r955c5wj4
# Log the OFF time for the `usage` command.
printf 'off %s\n' "$(date +%s)" >> "$HOME/cloud-usage.log"
echo "[cloud-off] codespace stopped. Phone auto-falls back to LOCAL rendering."
