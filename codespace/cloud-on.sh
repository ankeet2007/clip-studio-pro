#!/usr/bin/env bash
# Turn the Clip Studio render cloud ON: resume the Codespace, start the worker + a public
# cloudflared tunnel, and point the phone at it. Self-contained (no dependency on repo scripts).
set -uo pipefail
CS=super-duper-capybara-wvrxj4p9r955c5wj4
echo "[cloud-on] resuming codespace + starting worker + tunnel (takes ~30-60s)..."
OUT=$(gh codespace ssh -c "$CS" -- '
SECRET=$(cat ~/worker_secret 2>/dev/null); [ -z "$SECRET" ] && SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 28) && printf "%s" "$SECRET" > ~/worker_secret
mkdir -p ~/clips_out
if ! curl -s --max-time 3 localhost:7860/health >/dev/null 2>&1; then
  cd /workspaces/clip-studio-pro/artifacts/api-server-pro
  setsid env DATABASE_URL="postgresql://x:x@localhost:5432/x" WORKER_SECRET="$SECRET" PORT=7860 CLIPS_OUTPUT_DIR="$HOME/clips_out" NODE_ENV=production CAPTION_LEAD_SEC="-0.12" node dist/worker.mjs > ~/worker.log 2>&1 </dev/null & echo $! > ~/worker.pid
  sleep 2
fi
[ -x ~/cloudflared ] || { wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O ~/cloudflared && chmod +x ~/cloudflared; }
[ -f ~/cf.pid ] && kill "$(cat ~/cf.pid)" 2>/dev/null
setsid ~/cloudflared tunnel --url http://localhost:7860 --no-autoupdate > ~/cf.log 2>&1 </dev/null & echo $! > ~/cf.pid
sleep 12
echo "URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" ~/cf.log | head -1)"
echo "SECRET=$SECRET"
')
echo "$OUT" | grep -vE "^(URL|SECRET)="
URL=$(echo "$OUT" | sed -n 's/^URL=//p' | head -1)
SECRET=$(echo "$OUT" | sed -n 's/^SECRET=//p' | head -1)
[ -z "$URL" ] && { echo "[cloud-on] FAILED — no tunnel URL (try 'cloud on' again in a few seconds)"; exit 1; }
printf 'export CLOUD_RENDER_URL="%s"\nexport CLOUD_RENDER_SECRET="%s"\n' "$URL" "$SECRET" \
  | ssh -F /root/.ssh/config phone 'cat > ~/myapp/cloud_render.env && chmod 600 ~/myapp/cloud_render.env'
ssh -F /root/.ssh/config phone 'bash ~/deploy_pro.sh >/dev/null 2>&1 || true'
# Log the ON time for the `usage` command (idempotent: an open session already covers a re-run).
printf 'on %s\n' "$(date +%s)" >> "$HOME/cloud-usage.log"
echo "[cloud-on] CLOUD ON — your phone now renders on the cloud."
echo "[cloud-on] ($URL)"
