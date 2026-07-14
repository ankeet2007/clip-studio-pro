#!/usr/bin/env bash
# Turn a Google Colab runtime into a BACKUP Clip Studio Pro render box — identical to the GitHub
# Codespace worker: the SAME artifacts/api-server-pro/dist/worker.mjs on :7860 behind a cloudflared
# tunnel. The phone offloads renders to it exactly like it offloads to the Codespace.
#
# USAGE — paste ONE cell into a Colab notebook and Run:
#     !curl -fsSL https://raw.githubusercontent.com/ankeet2007/clip-studio-pro/master/codespace/colab-boot.sh | bash
#
# It prints a single line to paste in the PHONE's Termux (bash ~/cloud-colab.sh <URL> <SECRET>) that
# points the phone at this Colab box. Keep the cell RUNNING — closing it kills the box. Colab free caps
# a session at ~12h and idle-stops ~90min, so this is a BACKUP for when 'cloud on' (Codespace) is down.
set -uo pipefail
REPO_URL=https://github.com/ankeet2007/clip-studio-pro
REPO=/content/clip-studio-pro
export HOME=${HOME:-/root}
export DEBIAN_FRONTEND=noninteractive
log(){ echo "[colab $(date +%T)] $*"; }
command -v sudo >/dev/null 2>&1 && SUDO=sudo || SUDO=""

log "1/8 apt: ffmpeg + fonts + build tools + python(PIL) + tmux…"
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq ffmpeg fonts-dejavu-core fonts-liberation fontconfig \
  cmake build-essential git curl wget python3 python3-pip python3-pil tmux >/dev/null
pip3 install -q pilmoji emoji Pillow >/dev/null 2>&1 \
  || pip3 install -q --break-system-packages pilmoji emoji Pillow >/dev/null 2>&1

log "2/8 node 22 (repo pins pnpm 10 → needs node >=22.13)…"
if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - >/dev/null 2>&1
  $SUDO apt-get install -y -qq nodejs >/dev/null 2>&1
fi
log "    node $(node -v 2>/dev/null)  npm $(npm -v 2>/dev/null)"

log "3/8 clone/refresh repo…"
if [ -d "$REPO/.git" ]; then git -C "$REPO" pull -q || true; else rm -rf "$REPO"; git clone -q --depth 1 "$REPO_URL" "$REPO"; fi

log "4/8 build worker (pnpm install + build.mjs → dist/worker.mjs)…"
cd "$REPO"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1 \
  || { $SUDO npm i -g pnpm >/dev/null 2>&1 && pnpm install >/dev/null 2>&1; }
( cd artifacts/api-server-pro && node ./build.mjs ) >/dev/null 2>&1
if [ -f artifacts/api-server-pro/dist/worker.mjs ]; then log "    worker built ✓"; else log "    FATAL: worker build failed"; exit 1; fi

log "5/8 whisper.cpp build + models (medium.en-q5_0 + Silero VAD)…"
# Colab's 2-core CPU can't run medium.en inside the connector's transcribe budget (observed 82-280s →
# understand_video returns empty). If a GPU is present (T4 runtime), build whisper.cpp with CUDA so
# medium.en runs in ~seconds. Falls back to a CPU build if there's no GPU or the CUDA build fails.
GPU=0; command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1 && GPU=1
WANT=cpu; [ "$GPU" = 1 ] && WANT=cuda
if [ -x "$HOME/whisper.cpp/build/bin/whisper-cli" ] && [ "$(cat "$HOME/whisper.cpp/.flavor" 2>/dev/null)" = "$WANT" ]; then
  log "    whisper already built ($WANT) ✓"
else
  rm -rf "$HOME/whisper.cpp"; git clone -q --depth 1 https://github.com/ggerganov/whisper.cpp "$HOME/whisper.cpp"
  if [ "$GPU" = 1 ]; then
    GPUNAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
    # Build ONLY for this GPU's compute capability (T4=7.5 → "75"). The default multi-arch CUDA build
    # compiles ggml-cuda for many GPU generations — ~15 min and can OOM the box. Single-arch ≈ 1-2 min.
    CC=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d '. ')
    [ -z "$CC" ] && CC=75
    # libggml-cuda.so links hundreds of kernel objects. On a Kaggle/Colab box the stock bfd `ld` can
    # run out of RAM at that final link → "collect2: error: ld returned 1 exit status" (compile hits
    # ~80% then dies at the LINK, not the compile). Strategy: (1) build once with the flash-attn kernel
    # set trimmed, capturing the FULL log to $BLOG; (2) if the link failed, retry ONLY the link with the
    # low-memory lld linker — the compiled objects are cached so this relinks in seconds, no recompile;
    # (3) if it still fails, print the REAL linker error (previously hidden by the progress-only filter)
    # so the cause is visible, then fall back to a CPU build.
    BLOG="$HOME/whisper_cuda_build.log"; : > "$BLOG"
    $SUDO apt-get install -y -qq lld >/dev/null 2>&1 || true
    log "    GPU detected ($GPUNAME, sm_$CC) → building whisper with CUDA (arch $CC only)…"
    cmake -S "$HOME/whisper.cpp" -B "$HOME/whisper.cpp/build" -DCMAKE_BUILD_TYPE=Release \
      -DGGML_CUDA=1 -DCMAKE_CUDA_ARCHITECTURES="$CC" -DGGML_CUDA_FA_ALL_QUANTS=OFF >>"$BLOG" 2>&1
    cmake --build "$HOME/whisper.cpp/build" -j"$(nproc)" --config Release 2>&1 | tee -a "$BLOG" | grep --line-buffered -E "^\[[ 0-9]+%\]" || true
    if [ ! -x "$HOME/whisper.cpp/build/bin/whisper-cli" ] && command -v ld.lld >/dev/null 2>&1; then
      log "    ⚠ first link failed → retrying the link with lld (low-memory, reuses compiled objects)…"
      cmake -S "$HOME/whisper.cpp" -B "$HOME/whisper.cpp/build" \
        -DCMAKE_SHARED_LINKER_FLAGS="-Xcompiler=-fuse-ld=lld" -DCMAKE_EXE_LINKER_FLAGS="-fuse-ld=lld" >>"$BLOG" 2>&1 || true
      cmake --build "$HOME/whisper.cpp/build" -j"$(nproc)" --config Release 2>&1 | tee -a "$BLOG" | grep --line-buffered -E "^\[[ 0-9]+%\]|[Ee]rror" || true
    fi
    if [ -x "$HOME/whisper.cpp/build/bin/whisper-cli" ]; then echo cuda > "$HOME/whisper.cpp/.flavor"; log "    whisper CUDA build ✓ (GPU)"
    else
      log "    ⚠ CUDA build still failing — REAL linker error (last 25 matching lines):"
      grep -iE "error|undefined reference|cannot find|memory exhausted|ld returned|fatal|no such file" "$BLOG" | tail -25
      log "    → falling back to CPU build"; rm -rf "$HOME/whisper.cpp/build"; GPU=0
    fi
  fi
  if [ "$GPU" = 0 ]; then
    log "    building whisper (CPU — medium.en will be slow; prefer a T4 GPU runtime)…"
    cmake -S "$HOME/whisper.cpp" -B "$HOME/whisper.cpp/build" -DCMAKE_BUILD_TYPE=Release >/dev/null 2>&1
    cmake --build "$HOME/whisper.cpp/build" -j"$(nproc)" --config Release >/dev/null 2>&1
    echo cpu > "$HOME/whisper.cpp/.flavor"
  fi
fi
mkdir -p "$HOME/whisper.cpp/models"
[ -s "$HOME/whisper.cpp/models/ggml-medium.en-q5_0.bin" ] || curl -fsSL -o "$HOME/whisper.cpp/models/ggml-medium.en-q5_0.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en-q5_0.bin
[ -s "$HOME/whisper.cpp/models/ggml-silero-v5.1.2.bin" ] || curl -fsSL -o "$HOME/whisper.cpp/models/ggml-silero-v5.1.2.bin" https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
ln -sf ggml-medium.en-q5_0.bin "$HOME/whisper.cpp/models/ggml-medium.en.bin"
# On a GPU box, also fetch large-v3 (q5_0, ~1.9GB) — generate_captions_pro.sh auto-uses it (with the
# large.v3 DTW preset) when a GPU is present, for top caption accuracy on noisy commentary. Skipped on
# CPU boxes (unusably slow to run there). Captions fall back to medium.en-q5_0 if this isn't present.
if [ "$GPU" = 1 ]; then
  [ -s "$HOME/whisper.cpp/models/ggml-large-v3-q5_0.bin" ] || { log "    fetching large-v3 q5_0 (~1.9GB, GPU box only)…"; curl -fsSL -o "$HOME/whisper.cpp/models/ggml-large-v3-q5_0.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin; }
fi

log "6/8 piper + 7 voices (must match the phone's set)…"
if [ ! -x "$HOME/piper/piper/piper" ]; then
  mkdir -p "$HOME/piper"; curl -fsSL https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz | tar xz -C "$HOME/piper"
fi
cd "$HOME/piper"
VB=https://huggingface.co/rhasspy/piper-voices/resolve/main/en
dlv(){ [ -s "$1.onnx" ] || curl -fsSL -o "$1.onnx" "$2"; [ -s "$1.onnx.json" ] || curl -fsSL -o "$1.onnx.json" "$2.json"; }
dlv en_GB-alan-medium                  "$VB/en_GB/alan/medium/en_GB-alan-medium.onnx"
dlv en_US-joe-medium                   "$VB/en_US/joe/medium/en_US-joe-medium.onnx"
dlv en_US-norman-medium                "$VB/en_US/norman/medium/en_US-norman-medium.onnx"
dlv en_GB-northern_english_male-medium "$VB/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx"
dlv en_US-hfc_male-medium              "$VB/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx"
dlv en_US-ryan-medium                  "$VB/en_US/ryan/medium/en_US-ryan-medium.onnx"
dlv en_US-lessac-medium                "$VB/en_US/lessac/medium/en_US-lessac-medium.onnx"

log "7/8 scripts symlink + grun shim + cloudflared…"
mkdir -p "$HOME/myapp"
ln -sfn "$REPO/scripts" "$HOME/myapp/scripts"
$SUDO sh -c 'printf "#!/bin/sh\nexec \"\$@\"\n" > /usr/local/bin/grun && chmod +x /usr/local/bin/grun'
[ -x "$HOME/cloudflared" ] || { curl -fsSL -o "$HOME/cloudflared" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x "$HOME/cloudflared"; }

log "8/8 start worker (supervised) + public tunnel…"
[ -s "$HOME/worker_secret" ] || head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 28 > "$HOME/worker_secret"
SECRET="$(cat "$HOME/worker_secret")"
mkdir -p "$HOME/clips_out"
# Supervisor in tmux: auto-restarts the worker on crash on the SAME port 7860, so the tunnel URL never
# rotates on a worker crash. Re-running this cell cleanly replaces it (kill-session first).
tmux kill-session -t worker 2>/dev/null || true
tmux new-session -d -s worker "cd $REPO/artifacts/api-server-pro && while true; do env DATABASE_URL='postgresql://x:x@localhost:5432/x' WORKER_SECRET='$SECRET' PORT=7860 CLIPS_OUTPUT_DIR='$HOME/clips_out' NODE_ENV=production CAPTION_LEAD_SEC=-0.12 node dist/worker.mjs >> '$HOME/worker.log' 2>&1; sleep 3; done"
sleep 4
# Quick tunnel: re-roll up to 4x, accepting only a URL whose /health actually answers.
URL=""
for i in 1 2 3 4; do
  tmux kill-session -t cf 2>/dev/null || true
  tmux new-session -d -s cf "$HOME/cloudflared tunnel --url http://localhost:7860 --no-autoupdate > $HOME/cf.log 2>&1"
  sleep 12
  U=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$HOME/cf.log" | tail -1)
  if [ -n "$U" ] && curl -sf --max-time 8 -o /dev/null "$U/health"; then URL="$U"; break; fi
  log "    tunnel attempt $i didn't register, re-rolling…"
done
if [ -z "$URL" ]; then log "FATAL: no tunnel URL came up. Re-run this cell."; exit 1; fi

echo
echo "=================================================================================="
echo "  ✅ COLAB RENDER BOX IS LIVE   (health: $(curl -s --max-time 4 localhost:7860/health))"
echo
echo "  👉 Paste this ONE line in the PHONE's Termux to offload renders to this box:"
echo
echo "        bash ~/cloud-colab.sh $URL $SECRET"
echo
echo "  Leave this cell RUNNING (closing it / disconnecting kills the box)."
echo "  Free-Colab limits: ~90min idle stop, ~12h hard cap → this is a BACKUP for 'cloud on'."
echo "=================================================================================="
echo
# Keep the runtime alive by tailing the worker log (foreground → the cell stays 'running').
exec tail -f "$HOME/worker.log"
