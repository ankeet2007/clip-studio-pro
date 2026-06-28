#!/bin/bash
INPUT="$1"
OUTPUT_SRT="$2"
OUTPUT_TXT="$3"
WHISPER="$HOME/whisper.cpp/build/bin/whisper-cli"
MODEL="$HOME/whisper.cpp/models/ggml-small.en.bin"
TMP_WAV="/data/data/com.termux/files/home/myapp/clips_output/tmp_audio_$$.wav"
TMP_BASE="/data/data/com.termux/files/home/myapp/clips_output/tmp_srt_$$"

# Get duration and calculate outro start
DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$INPUT" 2>/dev/null)
OUTRO_START=$(python3 -c "d=float('${DURATION}'); print(max(0, d-2))" 2>/dev/null || echo "9999")

ffmpeg -y -i "$INPUT" -ar 16000 -ac 1 -c:a pcm_s16le "$TMP_WAV" 2>/dev/null
"$WHISPER" -m "$MODEL" -f "$TMP_WAV" -osrt -otxt -of "$TMP_BASE" -t 2 2>/dev/null
rm -f "$TMP_WAV"

if [ ! -f "${TMP_BASE}.srt" ]; then echo "FAIL"; exit 1; fi

# Copy raw transcript text to output path if requested
if [ -n "$OUTPUT_TXT" ] && [ -f "${TMP_BASE}.txt" ]; then
  cp "${TMP_BASE}.txt" "$OUTPUT_TXT"
fi
rm -f "${TMP_BASE}.txt"

python3 "$HOME/myapp/scripts/filter_srt.py" "${TMP_BASE}.srt" "$OUTPUT_SRT" "$OUTRO_START"
rm -f "${TMP_BASE}.srt"

[ -f "$OUTPUT_SRT" ] && echo "OK" || echo "FAIL"
