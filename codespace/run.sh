#!/usr/bin/env bash
# Start the render worker + a public cloudflared tunnel. Prints WORKER_URL + WORKER_SECRET
# to paste into the phone's ~/myapp/cloud_render.env. Idempotent-ish; re-run to (re)start.
set -uo pipefail
REPO_API="$(cd "$(dirname "$0")/../artifacts/api-server-pro" && pwd)"
[ -s "$HOME/worker_secret" ] || head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 28 > "$HOME/worker_secret"
SECRET="$(cat "$HOME/worker_secret")"
mkdir -p "$HOME/clips_out"

# worker (kill any old one by PID file — never `pkill -f dist/worker.mjs`, it matches your shell)
[ -f "$HOME/worker.pid" ] && kill "$(cat "$HOME/worker.pid")" 2>/dev/null || true
cd "$REPO_API"
setsid env DATABASE_URL='postgresql://x:x@localhost:5432/x' WORKER_SECRET="$SECRET" \
  PORT=7860 CLIPS_OUTPUT_DIR="$HOME/clips_out" NODE_ENV=production \
  node dist/worker.mjs > "$HOME/worker.log" 2>&1 < /dev/null & echo $! > "$HOME/worker.pid"
sleep 2

# public tunnel
if [ ! -x "$HOME/cloudflared" ]; then
  wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O "$HOME/cloudflared" && chmod +x "$HOME/cloudflared"
fi
[ -f "$HOME/cf.pid" ] && kill "$(cat "$HOME/cf.pid")" 2>/dev/null || true
setsid "$HOME/cloudflared" tunnel --url http://localhost:7860 --no-autoupdate > "$HOME/cf.log" 2>&1 < /dev/null & echo $! > "$HOME/cf.pid"
sleep 12

URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$HOME/cf.log" | head -1)"
echo "worker health: $(curl -s --max-time 4 localhost:7860/health)"
echo "WORKER_URL=$URL"
echo "WORKER_SECRET=$SECRET"
