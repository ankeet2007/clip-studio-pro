#!/usr/bin/env bash
# Reproducible render-worker setup for a Clip Studio Pro Codespace.
#
# WHY THIS EXISTS: the previous free render box died because its toolchain was installed by hand into
# the container's throwaway layer (home dir + apt), with NOTHING pinned. A routine Codespace rebuild
# wiped it AND landed on Alpine (musl), where piper's glibc ONNX runtime can't run. This file fixes
# both mistakes: the devcontainer pins a Debian/glibc image, and this script — run by postCreateCommand
# on every create/rebuild — reinstalls the ENTIRE render stack idempotently, so the box SELF-HEALS.
set -uo pipefail
REPO=/workspaces/clip-studio-pro
log(){ echo "[setup] $*"; }

log "apt: ffmpeg + build tools + python (Pillow for watermark detect) + tmux…"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg cmake build-essential git curl python3 python3-pip python3-pil tmux >/dev/null
# pilmoji (emoji-in-headline PNGs, used by scripts/render_headline.py) — pip only, not in apt. Without it
# the render dies at "Beat #1: ModuleNotFoundError: No module named 'pilmoji'".
pip3 install --break-system-packages -q pilmoji >/dev/null 2>&1 || sudo pip3 install --break-system-packages -q pilmoji >/dev/null 2>&1

log "build the render worker (pnpm install + esbuild → dist/worker.mjs)…"
cd "$REPO"
# corepack (bundled with node) uses the pnpm version the repo pins in package.json's packageManager —
# node 22 image satisfies it (pnpm 10 needs node >=22.13; node 20 was the earlier build failure).
corepack enable >/dev/null 2>&1 || sudo corepack enable >/dev/null 2>&1
pnpm install --frozen-lockfile 2>&1 | tail -2 || pnpm install 2>&1 | tail -2
( cd artifacts/api-server-pro && node ./build.mjs )
[ -f artifacts/api-server-pro/dist/worker.mjs ] && log "worker built ✓" || log "WARN worker build produced no dist/worker.mjs"

log "whisper.cpp (captions) — build + models…"
if [ ! -x "$HOME/whisper.cpp/build/bin/whisper-cli" ]; then
  rm -rf "$HOME/whisper.cpp"
  git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$HOME/whisper.cpp"
  cmake -S "$HOME/whisper.cpp" -B "$HOME/whisper.cpp/build" >/dev/null
  cmake --build "$HOME/whisper.cpp/build" -j --config Release >/dev/null
fi
mkdir -p "$HOME/whisper.cpp/models"
[ -s "$HOME/whisper.cpp/models/ggml-medium.en-q5_0.bin" ] || curl -fsSL -o "$HOME/whisper.cpp/models/ggml-medium.en-q5_0.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en-q5_0.bin
[ -s "$HOME/whisper.cpp/models/ggml-silero-v5.1.2.bin" ] || curl -fsSL -o "$HOME/whisper.cpp/models/ggml-silero-v5.1.2.bin" https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
# The render worker's transcribe endpoint (understand_video's cloud path) defaults to ggml-medium.en.bin;
# the caption script uses the q5_0 variant. Point the default name at the q5_0 we downloaded so both work
# off one model (no separate 1.5GB full-model download).
ln -sf ggml-medium.en-q5_0.bin "$HOME/whisper.cpp/models/ggml-medium.en.bin"

log "piper (voiceover) — binary + 7 voices…"
if [ ! -x "$HOME/piper/piper/piper" ]; then
  mkdir -p "$HOME/piper"
  curl -fsSL https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz | tar xz -C "$HOME/piper"
fi
cd "$HOME/piper"
VB=https://huggingface.co/rhasspy/piper-voices/resolve/main/en
dlv(){ [ -s "$1.onnx" ] || curl -fsSL -o "$1.onnx" "$2"; [ -s "$1.onnx.json" ] || curl -fsSL -o "$1.onnx.json" "$2.json"; }
dlv en_GB-alan-medium                 "$VB/en_GB/alan/medium/en_GB-alan-medium.onnx"
dlv en_US-joe-medium                  "$VB/en_US/joe/medium/en_US-joe-medium.onnx"
dlv en_US-norman-medium               "$VB/en_US/norman/medium/en_US-norman-medium.onnx"
dlv en_GB-northern_english_male-medium "$VB/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx"
dlv en_US-hfc_male-medium             "$VB/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx"
dlv en_US-ryan-medium                 "$VB/en_US/ryan/medium/en_US-ryan-medium.onnx"
dlv en_US-lessac-medium               "$VB/en_US/lessac/medium/en_US-lessac-medium.onnx"

log "scripts link + grun shim + cloudflared…"
mkdir -p "$HOME/myapp"
ln -sfn "$REPO/scripts" "$HOME/myapp/scripts"   # worker looks for ~/myapp/scripts
# the caption/voiceover scripts call `grun <binary>` (glibc-runner on the phone); on a glibc box grun
# is just a passthrough that execs its args.
sudo sh -c 'printf "#!/bin/sh\nexec \"\$@\"\n" > /usr/local/bin/grun && chmod +x /usr/local/bin/grun'
[ -x "$HOME/cloudflared" ] || { curl -fsSL -o "$HOME/cloudflared" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x "$HOME/cloudflared"; }

log "verify piper actually synthesizes (the Alpine make-or-break)…"
printf 'setup test' | "$HOME/piper/piper/piper" -m "$HOME/piper/en_GB-alan-medium.onnx" --espeak_data "$HOME/piper/piper/espeak-ng-data" -f /tmp/piper_check.wav 2>/dev/null \
  && [ -s /tmp/piper_check.wav ] && log "piper OK ✓" || log "WARN piper synth failed"

log "DONE ✓  (start the worker + tunnel with 'cloud on')"
