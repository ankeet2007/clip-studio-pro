#!/usr/bin/env bash
# One-shot setup for the Clip Studio render worker on a GitHub Codespace (or any x86_64
# Ubuntu box). After creating a codespace on this repo, run:  bash codespace/setup.sh
# Installs ffmpeg + whisper.cpp (+models) + piper (+voice) + python deps, drops the
# adapted caption/voiceover scripts into ~/myapp/scripts, and builds the worker.
set -uo pipefail
log(){ echo "[$(date +%T)] $*"; }
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPO_API="$ROOT/artifacts/api-server-pro"

log "1/6 apt: ffmpeg + fonts + build deps"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ffmpeg fonts-dejavu-core fonts-liberation fontconfig build-essential cmake git wget curl >/dev/null 2>&1

log "2/6 whisper.cpp build + models (medium.en primary, small.en fallback, Silero VAD)"
if [ ! -e "$HOME/whisper.cpp/build/bin/whisper-cli" ]; then
  rm -rf "$HOME/whisper.cpp"; git clone -q https://github.com/ggml-org/whisper.cpp "$HOME/whisper.cpp"
  cmake -S "$HOME/whisper.cpp" -B "$HOME/whisper.cpp/build" -DCMAKE_BUILD_TYPE=Release >/dev/null 2>&1
  cmake --build "$HOME/whisper.cpp/build" -j"$(nproc)" >/dev/null 2>&1
fi
mkdir -p "$HOME/whisper.cpp/models"; cd "$HOME/whisper.cpp/models"
[ -s ggml-medium.en.bin ]     || wget -q -O ggml-medium.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin
[ -s ggml-small.en.bin ]      || wget -q -O ggml-small.en.bin  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
[ -s ggml-silero-v5.1.2.bin ] || bash "$HOME/whisper.cpp/models/download-vad-model.sh" silero-v5.1.2 >/dev/null 2>&1 || true

log "3/6 piper TTS + ALL voices (must match the phone's ~/piper/*.onnx set)"
if [ ! -x "$HOME/piper/piper" ]; then
  cd "$HOME"; wget -q -O piper.tgz https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz; tar xzf piper.tgz; rm -f piper.tgz
fi
mkdir -p "$HOME/piper/voices"
PV_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"
# voice-name  ->  HF subpath. Keep in sync with the phone's installed voices.
for pair in \
  "en_US-lessac-medium:en/en_US/lessac/medium" \
  "en_US-joe-medium:en/en_US/joe/medium" \
  "en_US-ryan-medium:en/en_US/ryan/medium" \
  "en_US-norman-medium:en/en_US/norman/medium" \
  "en_US-hfc_male-medium:en/en_US/hfc_male/medium" \
  "en_GB-alan-medium:en/en_GB/alan/medium" \
  "en_GB-northern_english_male-medium:en/en_GB/northern_english_male/medium"; do
  vname="${pair%%:*}"; vpath="${pair#*:}"
  [ -s "$HOME/piper/voices/$vname.onnx" ] && continue
  wget -q -O "$HOME/piper/voices/$vname.onnx"      "$PV_BASE/$vpath/$vname.onnx"
  wget -q -O "$HOME/piper/voices/$vname.onnx.json" "$PV_BASE/$vpath/$vname.onnx.json"
done

log "4/6 python deps (Pillow + pilmoji for render_headline.py)"
pip install --user --quiet Pillow pilmoji emoji >/dev/null 2>&1 || true

log "5/6 install caption/voiceover scripts into ~/myapp/scripts (x86_64-adapted)"
mkdir -p "$HOME/myapp/scripts"
cp "$ROOT"/scripts/*.py "$HOME/myapp/scripts/" 2>/dev/null || true   # karaoke, filter_srt, headline, etc.
cp "$HERE"/scripts/*.sh "$HOME/myapp/scripts/"; chmod +x "$HOME/myapp/scripts/"*.sh

log "6/6 build the worker"
cd "$REPO_API"
corepack enable >/dev/null 2>&1 || true
pnpm install >/dev/null 2>&1 || { npm i -g pnpm >/dev/null 2>&1 && pnpm install >/dev/null 2>&1; }
node build.mjs >/dev/null 2>&1 && log "built dist/worker.mjs" || log "BUILD FAILED"

log "DONE. Start it with:  bash codespace/run.sh   (prints the public URL + secret)"
