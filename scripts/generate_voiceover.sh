#!/bin/bash
# Generates a Piper TTS WAV from a hook/narration line, for Clip Studio Pro voiceovers.
# Usage: generate_voiceover.sh "<text>" <output.wav> [voice-name] [length_scale]
# Piper is a glibc binary, so it is run through Termux's glibc-runner (grun).
HOOK="$1"
OUTPUT_WAV="$2"
# Voice model. Default = en_US-joe-medium (deep US male). Pass a 3rd arg
# (e.g. en_GB-alan-medium) to override — see ~/piper/*.onnx for what's installed.
VOICE="${3:-en_US-joe-medium}"
# Speaking pace = Piper's --length_scale. 1.0 = normal; higher = slower / heavier.
# Blank/invalid ⇒ 1.0. Clamped to a sane [0.7, 1.8] range.
SPEED="${4:-1.0}"
case "$SPEED" in ''|*[!0-9.]*) SPEED=1.0 ;; esac
awk "BEGIN{s=$SPEED+0; if(s<0.7||s>1.8) exit 1}" >/dev/null 2>&1 || SPEED=1.0
PIPER="$HOME/piper/piper/piper"
MODEL="$HOME/piper/$VOICE.onnx"
ESPEAK_DATA="$HOME/piper/piper/espeak-ng-data"

if [ -z "$HOOK" ] || [ -z "$OUTPUT_WAV" ]; then echo "FAIL: missing args"; exit 1; fi
if ! command -v grun >/dev/null 2>&1; then echo "FAIL: grun (glibc-runner) not installed"; exit 1; fi
# Fall back to a known-good voice if the requested model isn't on this phone, so a bad
# voice name degrades to sound rather than a silent (failed) voiceover.
if [ ! -f "$MODEL" ]; then
  for FALLBACK in en_US-joe-medium en_US-ryan-medium en_US-lessac-medium; do
    if [ -f "$HOME/piper/$FALLBACK.onnx" ]; then MODEL="$HOME/piper/$FALLBACK.onnx"; break; fi
  done
fi
if [ ! -f "$MODEL" ]; then echo "FAIL: piper voice model missing at $MODEL"; exit 1; fi

printf '%s' "$HOOK" | grun "$PIPER" -m "$MODEL" --espeak_data "$ESPEAK_DATA" --length_scale "$SPEED" -f "$OUTPUT_WAV" 2>/dev/null

[ -f "$OUTPUT_WAV" ] && echo "OK" || echo "FAIL"
