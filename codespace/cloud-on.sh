#!/usr/bin/env bash
# Turn the Clip Studio render cloud ON: resume the Codespace, start the worker + a public
# cloudflared tunnel, and point the phone at it. Self-contained (no dependency on repo scripts).
set -uo pipefail
CS=glorious-telegram-jrj9wgv4jjw4fp9pp
echo "[cloud-on] resuming codespace + starting worker + tunnel (takes ~30-60s)..."
OUT=$(gh codespace ssh -c "$CS" -- '
SECRET=$(cat ~/worker_secret 2>/dev/null); [ -z "$SECRET" ] && SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 28) && printf "%s" "$SECRET" > ~/worker_secret
mkdir -p ~/clips_out
if ! curl -s --max-time 3 localhost:7860/health >/dev/null 2>&1; then
  tmux kill-session -t worker 2>/dev/null
  # Supervisor loop: if the worker process ever crashes (OOM/exception) it auto-restarts in 3s on the
  # SAME port 7860, so the cloudflared tunnel (which points at localhost:7860) keeps working with NO
  # URL rotation. This heals a genuine worker crash without needing another `cloud on`. (The dominant
  # death is still the GitHub 30-min idle-STOP, which kills the whole box — fixed by --idle-timeout.)
  tmux new-session -d -s worker "cd /workspaces/clip-studio-pro/artifacts/api-server-pro && while true; do env DATABASE_URL=postgresql://x:x@localhost:5432/x WORKER_SECRET=$SECRET PORT=7860 CLIPS_OUTPUT_DIR=$HOME/clips_out NODE_ENV=production CAPTION_LEAD_SEC=-0.12 node dist/worker.mjs >> $HOME/worker.log 2>&1; sleep 3; done"
  sleep 4
fi
[ -x ~/cloudflared ] || { wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O ~/cloudflared && chmod +x ~/cloudflared; }
# A trycloudflare quick tunnel sometimes fails to register (a URL lands in the log but its DNS/edge
# never comes up). Re-roll up to 4x, verifying the PUBLIC url actually answers before accepting it.
URL=""
for i in 1 2 3 4; do
  tmux kill-session -t cf 2>/dev/null
  tmux new-session -d -s cf "$HOME/cloudflared tunnel --url http://localhost:7860 --no-autoupdate > $HOME/cf.log 2>&1"
  sleep 12
  U=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" $HOME/cf.log | tail -1)
  if [ -n "$U" ] && curl -sf --max-time 8 -o /dev/null "$U/health"; then URL="$U"; break; fi
  echo "  (tunnel attempt $i did not register, re-rolling...)" >&2
done
echo "URL=$URL"
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
# TELL THE TRUTH: verify the PHONE itself can reach the cloud. The codespace-side check above confirms
# the tunnel is public, but the quick tunnel can die moments later (or the phone can't reach it) — then
# renders SILENTLY fall back to local while this still prints "CLOUD ON". Health-check through the
# just-written env, retrying ON THE PHONE (remote sleep) so a slow restart isn't a false negative.
PHONE_HTTP=$(ssh -F /root/.ssh/config phone 'set -a; . ~/myapp/cloud_render.env 2>/dev/null; set +a; c=000; for i in 1 2 3 4; do c=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$CLOUD_RENDER_URL/health" 2>/dev/null); [ "$c" = "200" ] && break; sleep 3; done; echo "$c"' 2>/dev/null)
if [ "$PHONE_HTTP" = "200" ]; then
  echo "[cloud-on] ✅ CLOUD ON — verified the phone reaches the cloud; renders now offload."
  echo "[cloud-on] ($URL)"
else
  echo "[cloud-on] ⚠️  Tunnel started but the PHONE got http=$PHONE_HTTP — it CANNOT reach the cloud,"
  echo "[cloud-on]     so renders will FALL BACK TO LOCAL (not the cloud). Re-run 'cloud on' in ~20s"
  echo "[cloud-on]     (the free quick tunnel sometimes dies right after coming up)."
  exit 1
fi
