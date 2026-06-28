#!/usr/bin/env python3
"""
Turn a (cleaned, segment-level) SRT into an animated ASS subtitle file with
active-word highlighting — the "viral Shorts" caption look.

Each SRT cue is a short phrase with a reliable [start,end] span. The phrase is
wrapped into display lines of a few words, the cue span is split across those
lines, and within each line the span is distributed evenly (weighted by word
length) so each word lights up as it is spoken. Per-word micro-timestamps from
whisper are NOT trusted (small.en back-loads them); even distribution over the
phrase span reads far more naturally.

Input SRT is expected to be already cleaned (non-speech stripped, overlaps and
outro handled by filter_srt.py).

Usage: python3 karaoke_captions.py <in.srt> <out.ass> [outro_start_sec]
"""
import re, sys

# ---- style knobs -----------------------------------------------------------
FONT          = "DejaVu Sans"
FONT_SIZE     = 78
OUTLINE       = 6
SHADOW        = 3
MARGIN_V      = 540          # px above bottom (PlayResY=1920 space)
WHITE         = r"&H00FFFFFF&"
HIGHLIGHT     = r"&H0000F4FF&"   # ASS &HBBGGRR -> bright yellow
PLAY_W, PLAY_H = 1080, 1920

MAX_WORDS = 5
MAX_CHARS = 24
MIN_LINE_DUR = 0.35


def srt_time_to_sec(t):
    h, m, s = t.strip().split(':')
    return int(h) * 3600 + int(m) * 60 + float(s.replace(',', '.'))


def ass_time(s):
    if s < 0: s = 0
    h = int(s // 3600); m = int((s % 3600) // 60); sec_f = s % 60
    cs = int(round((sec_f - int(sec_f)) * 100))
    sec = int(sec_f)
    if cs == 100:
        cs = 0; sec += 1
    return f"{h:d}:{m:02d}:{sec:02d}.{cs:02d}"


def parse_cues(path):
    with open(path) as f:
        blocks = f.read().strip().split('\n\n')
    cues = []
    for b in blocks:
        lines = b.strip().split('\n')
        if len(lines) < 3 or ' --> ' not in lines[1]:
            continue
        a, z = lines[1].split(' --> ')
        text = ' '.join(x.strip() for x in lines[2:]).strip()
        if text:
            cues.append((srt_time_to_sec(a), srt_time_to_sec(z), text))
    cues.sort(key=lambda c: c[0])
    return cues


def wrap_words(words):
    """Greedily pack words into display lines (<= MAX_WORDS, <= MAX_CHARS)."""
    lines, cur, cur_chars = [], [], 0
    for w in words:
        add = len(w) + (1 if cur else 0)
        if cur and (len(cur) >= MAX_WORDS or cur_chars + add > MAX_CHARS):
            lines.append(cur); cur, cur_chars = [], 0
            add = len(w)
        cur.append(w); cur_chars += add
    if cur:
        lines.append(cur)
    return lines


def main():
    src, dst = sys.argv[1], sys.argv[2]
    outro_start = float(sys.argv[3]) if len(sys.argv) > 3 else 1e9

    events = []
    for c_start, c_end, text in parse_cues(src):
        if c_start >= outro_start:
            continue
        c_end = min(c_end, outro_start)
        if c_end <= c_start:
            continue

        disp_lines = wrap_words(text.split())
        # Split the cue span across display lines, weighted by word count.
        total_words = sum(len(l) for l in disp_lines)
        span = c_end - c_start
        t = c_start
        for line in disp_lines:
            line_dur = span * len(line) / total_words
            ls, le = t, t + line_dur
            t = le

            # Even, length-weighted distribution of the line span across words.
            weights = [len(w) + 2 for w in line]
            total = sum(weights)
            wt = ls
            for i, w in enumerate(line):
                d = (le - ls) * weights[i] / total
                ws, we = wt, wt + d
                wt = we
                if we <= ws:
                    continue
                parts = []
                for j, tok in enumerate(line):
                    if j == i:
                        parts.append("{\\c" + HIGHLIGHT + "}" + tok + "{\\c" + WHITE + "}")
                    else:
                        parts.append(tok)
                events.append((ws, we, "{\\c" + WHITE + "}" + " ".join(parts)))

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {PLAY_W}
PlayResY: {PLAY_H}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{FONT},{FONT_SIZE},{WHITE},&H000000FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,{OUTLINE},{SHADOW},2,60,60,{MARGIN_V},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    with open(dst, 'w') as f:
        f.write(header)
        for ws, we, text in events:
            f.write(f"Dialogue: 0,{ass_time(ws)},{ass_time(we)},Cap,,0,0,0,,{text}\n")


if __name__ == "__main__":
    main()
