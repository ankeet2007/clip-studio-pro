#!/bin/bash
# Generates a Piper TTS WAV from a hook line, for Clip Studio Pro intro-hook voiceovers.
# Usage: generate_voiceover.sh "<hook text>" <output.wav>
# Piper is a glibc binary, so it is run through Termux's glibc-runner (grun).
HOOK="$1"
OUTPUT_WAV="$2"
PIPER="$HOME/piper/piper/piper"
MODEL="$HOME/piper/en_US-lessac-medium.onnx"
ESPEAK_DATA="$HOME/piper/piper/espeak-ng-data"

if [ -z "$HOOK" ] || [ -z "$OUTPUT_WAV" ]; then echo "FAIL: missing args"; exit 1; fi
if ! command -v grun >/dev/null 2>&1; then echo "FAIL: grun (glibc-runner) not installed"; exit 1; fi
if [ ! -f "$MODEL" ]; then echo "FAIL: piper voice model missing at $MODEL"; exit 1; fi

printf '%s' "$HOOK" | grun "$PIPER" -m "$MODEL" --espeak_data "$ESPEAK_DATA" -f "$OUTPUT_WAV" 2>/dev/null

[ -f "$OUTPUT_WAV" ] && echo "OK" || echo "FAIL"
