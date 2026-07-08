#!/bin/bash
# Codespace-adapted Pro captions: whisper.cpp DTW word-timing + optional Silero VAD.
# Model = medium.en (best English accuracy on CPU); DTW preset MUST match the model.
# Outputs: $2 cleaned SRT, ${2%.srt}.json raw DTW JSON (karaoke), $3 transcript.
INPUT="$1"; OUTPUT_SRT="$2"; OUTPUT_TXT="$3"
JSON_OUT="${OUTPUT_SRT%.srt}.json"
WHISPER="$HOME/whisper.cpp/build/bin/whisper-cli"
MODEL="$HOME/whisper.cpp/models/ggml-medium.en.bin"; DTW_PRESET="medium.en"
# fall back to small.en if medium hasn't finished downloading
if [ ! -f "$MODEL" ]; then MODEL="$HOME/whisper.cpp/models/ggml-small.en.bin"; DTW_PRESET="small.en"; fi
VAD_MODEL="$HOME/whisper.cpp/models/ggml-silero-v5.1.2.bin"
TMP_WAV="$(mktemp /tmp/cap_XXXXXX.wav)"; TMP_BASE="$(mktemp -u /tmp/capb_XXXXXX)"
mkdir -p "$HOME/myapp"

DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$INPUT" 2>/dev/null)
OUTRO_START=$(python3 -c "d=float('${DURATION}'); print(max(0, d-2))" 2>/dev/null || echo "9999")

ffmpeg -y -i "$INPUT" -ar 16000 -ac 1 -c:a pcm_s16le "$TMP_WAV" 2>/dev/null

VAD=()
[ -f "$VAD_MODEL" ] && VAD=(--vad --vad-model "$VAD_MODEL" --vad-threshold 0.5 --vad-speech-pad-ms 60)

"$WHISPER" -m "$MODEL" -f "$TMP_WAV" \
  -nfa -dtw "$DTW_PRESET" -ojf -osrt -otxt -of "$TMP_BASE" -t 4 \
  "${VAD[@]}" \
  2>>"$HOME/myapp/caption_debug.log"
rm -f "$TMP_WAV"

if [ ! -f "${TMP_BASE}.srt" ]; then echo "FAIL"; exit 1; fi
[ -f "${TMP_BASE}.json" ] && cp "${TMP_BASE}.json" "$JSON_OUT"; rm -f "${TMP_BASE}.json"
if [ -n "$OUTPUT_TXT" ] && [ -f "${TMP_BASE}.txt" ]; then cp "${TMP_BASE}.txt" "$OUTPUT_TXT"; fi
rm -f "${TMP_BASE}.txt"
python3 "$HOME/myapp/scripts/filter_srt.py" "${TMP_BASE}.srt" "$OUTPUT_SRT" "$OUTRO_START"
rm -f "${TMP_BASE}.srt"
[ -f "$OUTPUT_SRT" ] && echo "OK" || echo "FAIL"
