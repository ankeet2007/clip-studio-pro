#!/data/data/com.termux/files/usr/bin/env bash
# NewsClub Indian-accent voiceover via Microsoft edge-tts (native en-IN neural voices),
# WITH A SPEED CONTROLLER. Piper mispronounces Indian names (its espeak phonemizer anglicizes
# them); edge-tts en-IN voices say Rahul Gandhi / Modi / Delhi / Dharmendra Pradhan natively.
#
# Usage: generate_voiceover_edge.sh "<text>" <output.wav> [voice] [speed]
#   voice : en-IN-NeerjaNeural (F, default) | en-IN-PrabhatNeural (M) | en-IN-NeerjaExpressiveNeural (F)
#   speed : multiplier. 1.0=normal, 1.2=20% faster, 0.9=10% slower. Clamped [0.5,2.0].
#           Mapped to edge-tts --rate=+/-N%. THIS is the voice speed controller.
set -uo pipefail
TEXT="${1:-}"; OUT="${2:-}"; VOICE="${3:-en-IN-NeerjaNeural}"; SPEED="${4:-1.0}"
if [ -z "$TEXT" ] || [ -z "$OUT" ]; then echo "usage: $0 <text> <out.wav> [voice] [speed]"; exit 1; fi
case "$SPEED" in ""|*[!0-9.]*) SPEED=1.0 ;; esac
awk "BEGIN{s=$SPEED+0; if(s<0.5||s>2.0) exit 1}" >/dev/null 2>&1 || SPEED=1.0
PCT=$(awk "BEGIN{printf \"%+.0f\", ($SPEED-1)*100}")
MP3="${OUT%.wav}.mp3"
edge-tts --voice "$VOICE" --rate="${PCT}%" --text "$TEXT" --write-media "$MP3" >/dev/null 2>&1
[ -f "$MP3" ] && ffmpeg -y -loglevel error -i "$MP3" -ar 22050 -ac 1 "$OUT" >/dev/null 2>&1
[ -f "$OUT" ] && echo "OK voice=$VOICE speed=${SPEED}x (rate ${PCT}%)" || echo "FAIL"
