#!/bin/bash
# Codespace-adapted Piper voiceover — native glibc, so NO grun (unlike the phone).
# Usage: generate_voiceover.sh "<text>" <output.wav> [voice-name] [length_scale]
HOOK="$1"; OUTPUT_WAV="$2"; VOICE="${3:-en_US-lessac-medium}"; SPEED="${4:-1.0}"
case "$SPEED" in ''|*[!0-9.]*) SPEED=1.0 ;; esac
awk "BEGIN{s=$SPEED+0; if(s<0.7||s>1.8) exit 1}" >/dev/null 2>&1 || SPEED=1.0
PIPER="$HOME/piper/piper"
ESPEAK_DATA="$HOME/piper/espeak-ng-data"
MODEL="$HOME/piper/voices/$VOICE.onnx"
export LD_LIBRARY_PATH="$HOME/piper:${LD_LIBRARY_PATH:-}"
if [ -z "$HOOK" ] || [ -z "$OUTPUT_WAV" ]; then echo "FAIL: missing args"; exit 1; fi
if [ ! -f "$MODEL" ]; then
  for FB in en_US-lessac-medium en_US-joe-medium en_US-ryan-medium; do
    [ -f "$HOME/piper/voices/$FB.onnx" ] && MODEL="$HOME/piper/voices/$FB.onnx" && break
  done
fi
if [ ! -f "$MODEL" ]; then echo "FAIL: piper voice model missing at $MODEL"; exit 1; fi
printf '%s' "$HOOK" | "$PIPER" -m "$MODEL" --espeak_data "$ESPEAK_DATA" --length_scale "$SPEED" -f "$OUTPUT_WAV" 2>/dev/null
[ -f "$OUTPUT_WAV" ] && echo "OK" || echo "FAIL"
