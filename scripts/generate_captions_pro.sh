#!/bin/bash
# Pro caption generation (Clip Studio Pro only).
#
# Pixel-perfect word sync (2026-06-30): whisper.cpp is now run with DTW token-level
# timestamps (`-nfa -dtw small.en -ojf`) so each word gets a REAL onset time instead
# of being spread evenly across its phrase (the old drift). NB: DTW is silently
# disabled when flash-attention is on — `-nfa` (no-flash-attn) is mandatory.
#
# Outputs:
#   $2 (OUTPUT_SRT)            cleaned segment SRT  -> plain-burn fallback
#   ${OUTPUT_SRT%.srt}.json    raw whisper DTW JSON -> karaoke_captions_pro.py (primary)
#   $3 (OUTPUT_TXT)            raw transcript
INPUT="$1"
OUTPUT_SRT="$2"
OUTPUT_TXT="$3"
JSON_OUT="${OUTPUT_SRT%.srt}.json"
WHISPER="$HOME/whisper.cpp/build/bin/whisper-cli"
MODEL="$HOME/whisper.cpp/models/ggml-small.en.bin"
TMP_WAV="/data/data/com.termux/files/home/myapp/clips_output/tmp_audio_$$.wav"
TMP_BASE="/data/data/com.termux/files/home/myapp/clips_output/tmp_srt_$$"
# DTW gives accurate per-word onsets, so no global nudge is needed. This only shifts
# the rarely-hit plain-SRT fallback; keep at 0.0 (raise a touch if it ever reads early).
CAPTION_DELAY=0.0

# Get duration and calculate outro start
DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$INPUT" 2>/dev/null)
OUTRO_START=$(python3 -c "d=float('${DURATION}'); print(max(0, d-2))" 2>/dev/null || echo "9999")

ffmpeg -y -i "$INPUT" -ar 16000 -ac 1 -c:a pcm_s16le "$TMP_WAV" 2>/dev/null
# -nfa: disable flash attention (REQUIRED for DTW). -dtw small.en: DTW alignment-head
# preset matching the model. -ojf: JSON-full (per-token t_dtw + offsets).
"$WHISPER" -m "$MODEL" -f "$TMP_WAV" -nfa -dtw small.en -ojf -osrt -otxt -of "$TMP_BASE" -t 4 2>/dev/null
rm -f "$TMP_WAV"

if [ ! -f "${TMP_BASE}.srt" ]; then echo "FAIL"; exit 1; fi

# Hand the DTW JSON to the karaoke step (word-level timing).
[ -f "${TMP_BASE}.json" ] && cp "${TMP_BASE}.json" "$JSON_OUT"
rm -f "${TMP_BASE}.json"

# Copy raw transcript text to output path if requested
if [ -n "$OUTPUT_TXT" ] && [ -f "${TMP_BASE}.txt" ]; then
  cp "${TMP_BASE}.txt" "$OUTPUT_TXT"
fi
rm -f "${TMP_BASE}.txt"

python3 "$HOME/myapp/scripts/filter_srt.py" "${TMP_BASE}.srt" "$OUTPUT_SRT" "$OUTRO_START"
rm -f "${TMP_BASE}.srt"

# Shift every cue +CAPTION_DELAY so captions land on/just after the speech, not before it.
if [ -f "$OUTPUT_SRT" ]; then
python3 - "$OUTPUT_SRT" "$CAPTION_DELAY" <<'PY'
import sys, re
path, delay = sys.argv[1], float(sys.argv[2])
def to_s(t):
    h, m, s = t.split(':'); return int(h)*3600 + int(m)*60 + float(s.replace(',', '.'))
def to_t(x):
    if x < 0: x = 0
    h = int(x//3600); m = int((x % 3600)//60); s = x % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace('.', ',')
rng = re.compile(r'(\d\d:\d\d:\d\d,\d+) --> (\d\d:\d\d:\d\d,\d+)')
out = []
for ln in open(path).read().split('\n'):
    m = rng.match(ln.strip())
    if m:
        out.append(f"{to_t(to_s(m.group(1))+delay)} --> {to_t(to_s(m.group(2))+delay)}")
    else:
        out.append(ln)
open(path, 'w').write('\n'.join(out))
PY
fi

[ -f "$OUTPUT_SRT" ] && echo "OK" || echo "FAIL"
