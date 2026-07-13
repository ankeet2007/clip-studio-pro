#!/usr/bin/env bash
# `cloud status` — report the TRUTH about the render cloud, not just the codespace box state.
# `gh codespace list` alone lies: the box can be "Available" while its quick tunnel is dead, so the
# phone can't reach it and renders silently fall back to LOCAL. This does a LIVE health-check from the
# phone through the URL the phone is actually configured with.
set -uo pipefail
CS=glorious-telegram-jrj9wgv4jjw4fp9pp

echo "[cloud-status] codespace box:"
gh codespace list 2>/dev/null | grep -F "$CS" || echo "  (not found)"

URL=$(ssh -F /root/.ssh/config phone 'set -a; . ~/myapp/cloud_render.env 2>/dev/null; set +a; echo "${CLOUD_RENDER_URL:-}"' 2>/dev/null)
if [ -z "$URL" ]; then
  echo "[cloud-status] phone has NO cloud_render.env → renders run LOCALLY. Run 'cloud on'."
  exit 0
fi

HTTP=$(ssh -F /root/.ssh/config phone 'set -a; . ~/myapp/cloud_render.env 2>/dev/null; set +a; curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$CLOUD_RENDER_URL/health" 2>/dev/null' 2>/dev/null)
if [ "$HTTP" = "200" ]; then
  echo "[cloud-status] ✅ CLOUD REACHABLE from the phone — renders OFFLOAD to the cloud."
  echo "[cloud-status]    ($URL)"
else
  echo "[cloud-status] ⚠️  phone CANNOT reach the cloud (http=$HTTP) — renders FALL BACK TO LOCAL."
  echo "[cloud-status]    The box may be up but its tunnel died. Run 'cloud on' to re-point. ($URL)"
fi
