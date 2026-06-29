#!/bin/bash
# Generates a Piper TTS WAV from a hook line, for Clip Studio Pro intro-hook voiceovers.
# Usage: generate_voiceover.sh "<hook text>" <output.wav> [voice-name]
# Piper is a glibc binary, so it is run through Termux's glibc-runner (grun).
HOOK="$1"
OUTPUT_WAV="$2"
# Voice model. Default = en_US-ryan-medium (user's chosen voice, 2026-06-29: expressive US
# male, best for viral hooks). Pass a 3rd arg (e.g. en_US-lessac-medium) to override.
VOICE="${3:-en_US-ryan-medium}"
PIPER="$HOME/piper/piper/piper"
MODEL="$HOME/piper/$VOICE.onnx"
ESPEAK_DATA="$HOME/piper/piper/espeak-ng-data"

if [ -z "$HOOK" ] || [ -z "$OUTPUT_WAV" ]; then echo "FAIL: missing args"; exit 1; fi
if ! command -v grun >/dev/null 2>&1; then echo "FAIL: grun (glibc-runner) not installed"; exit 1; fi
if [ ! -f "$MODEL" ]; then echo "FAIL: piper voice model missing at $MODEL"; exit 1; fi

printf '%s' "$HOOK" | grun "$PIPER" -m "$MODEL" --espeak_data "$ESPEAK_DATA" -f "$OUTPUT_WAV" 2>/dev/null

[ -f "$OUTPUT_WAV" ] && echo "OK" || echo "FAIL"
