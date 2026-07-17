#!/usr/bin/env python3
"""
DTW karaoke captions (Clip Studio Pro only).

Builds animated word-by-word ("active word highlighted") ASS subtitles from
whisper.cpp's *DTW token-level timestamps* (`-nfa -dtw small.en -ojf` JSON),
so each word lights up exactly when it is spoken — pixel-perfect sync instead
of the old "spread words evenly across the phrase span" heuristic in
karaoke_captions.py (which back-loaded / drifted in pause-heavy speech).

Input is whisper's JSON-full output. Each segment carries `tokens[]`, each
token a `t_dtw` (DTW onset, in centiseconds) plus heuristic `offsets` (ms).
Sub-word tokens (no leading space) and trailing punctuation are merged back
into whole words; the word's onset = its first token's t_dtw (offsets as
fallback). A word stays highlighted until the next word's onset.

Falls back to writing nothing (header only, no Dialogue lines) if the JSON is
missing/empty, so the caller burns the plain SRT instead.

Usage: python3 karaoke_captions_pro.py <whisper.json> <out.ass> [outro_start_sec] [highlight_hex]

`highlight_hex` (optional) is the spoken/active-word colour as "#RRGGBB" (or bare
"RRGGBB"); blank/invalid falls back to the classic bright yellow.
"""
import json, os, re, sys

# ---- style knobs (kept identical to karaoke_captions.py for a consistent look)
FONT          = "DejaVu Sans"
FONT_SIZE     = 78
OUTLINE       = 6
SHADOW        = 3
MARGIN_V      = 540          # px above bottom (PlayResY=1920 space)
WHITE         = r"&H00FFFFFF&"
HIGHLIGHT     = r"&H0000F4FF&"   # ASS &HAABBGGRR -> bright yellow (the classic default)
PLAY_W, PLAY_H = 1080, 1920


def hex_to_ass(hexstr, default=HIGHLIGHT):
    """Convert a "#RRGGBB" / "RRGGBB" UI colour into an opaque ASS &H00BBGGRR& string.
    Blank or malformed input returns the classic-yellow default."""
    if not hexstr:
        return default
    h = str(hexstr).strip().lstrip('#')
    if len(h) != 6:
        return default
    try:
        int(h, 16)
    except ValueError:
        return default
    rr, gg, bb = h[0:2], h[2:4], h[4:6]
    return f"&H00{bb}{gg}{rr}&".upper()

MAX_WORDS     = 5
MAX_CHARS     = 24
GAP_BREAK     = 0.7      # start a new display line when speech pauses this long
MIN_WORD_DUR  = 0.12     # floor so a highlight is never zero-length
TAIL_DUR      = 0.50     # how long the very last word of the clip lingers
MAX_TAIL      = 1.40     # cap on how long a line lingers across a pause before the next
EPS           = 0.03     # tiny gap between display lines so libass never stacks two
LEAD          = float(os.environ.get("CAPTION_LEAD_SEC", "0") or "0")  # global nudge (s): NEGATIVE = captions earlier (env-tunable, e.g. -0.15 to lead the voice)


def ass_time(s):
    if s < 0:
        s = 0
    h = int(s // 3600); m = int((s % 3600) // 60); sec_f = s % 60
    cs = int(round((sec_f - int(sec_f)) * 100))
    sec = int(sec_f)
    if cs == 100:
        cs = 0; sec += 1
    return f"{h:d}:{m:02d}:{sec:02d}.{cs:02d}"


def clean_text(t):
    """Strip whisper non-speech markers: (music), [applause], leading dashes."""
    t = re.sub(r'[\(\[].*?[\)\]]', '', t)
    t = re.sub(r'^\s*-\s*', '', t)
    return t.strip()


def extract_words(segs):
    """Flatten DTW tokens into whole words: [text, onset_sec], monotonic in time."""
    words = []
    for s in segs:
        # Skip whole non-speech segments, e.g. "(speaking in foreign language)".
        if not clean_text(s.get("text", "")):
            continue
        # Collect this segment's real tokens with their raw (possibly VAD-compacted)
        # onset in seconds.
        seg_toks = []
        for t in s.get("tokens", []):
            tx = t.get("text", "")
            if tx.startswith("[_"):      # special tokens: [_BEG_], [_TT_94], ...
                continue
            dtw = t.get("t_dtw", -1)
            if dtw is not None and dtw >= 0:
                onset = dtw / 100.0          # centiseconds -> seconds
            else:
                onset = t.get("offsets", {}).get("from", 0) / 1000.0
            seg_toks.append([tx, onset])
        if not seg_toks:
            continue
        # --- VAD timeline fix -------------------------------------------------
        # With --vad, whisper.cpp remaps the SEGMENT offsets to the real timeline
        # but leaves per-token t_dtw/offsets on the VAD-COMPACTED timeline (silence
        # removed). Left as-is the karaoke drifts progressively early — words after
        # a non-speech gap fire seconds ahead of the audio. Linearly remap each
        # segment's token onsets from their compacted span onto the segment's true
        # [offsets.from, offsets.to] span. Identity when nothing was compacted
        # (e.g. VAD off), so it is always safe to apply.
        off = s.get("offsets", {})
        o0, o1 = off.get("from"), off.get("to")
        if o0 is not None and o1 is not None:
            o0 /= 1000.0; o1 /= 1000.0
            cs = [c for _, c in seg_toks]
            c0, c1 = min(cs), max(cs)
            if c1 > c0 and o1 > o0:
                scale = (o1 - o0) / (c1 - c0)
                for tk in seg_toks:
                    tk[1] = o0 + (tk[1] - c0) * scale
            else:
                for tk in seg_toks:
                    tk[1] = o0
        # ---------------------------------------------------------------------
        # Merge sub-word tokens / punctuation back into whole words.
        for tx, onset in seg_toks:
            if tx.startswith(" "):
                words.append([tx[1:], onset])   # leading space => new word
            elif words:
                words[-1][0] += tx              # sub-word / punctuation => merge
            else:
                words.append([tx, onset])

    # Clean each assembled word; drop stray bracket/dash; fold pure punctuation back.
    cleaned = []
    for txt, onset in words:
        c = re.sub(r'[\(\)\[\]]', '', txt)
        c = re.sub(r'^[\-–—]+\s*', '', c).strip()
        if not c:
            continue
        if re.fullmatch(r'[^\w]+', c):          # lone punctuation -> attach to prev
            if cleaned:
                cleaned[-1][0] += c
            continue
        cleaned.append([c, onset + LEAD])

    # Enforce non-decreasing onsets (DTW is usually monotonic; guard the rare slip).
    for i in range(1, len(cleaned)):
        if cleaned[i][1] < cleaned[i - 1][1]:
            cleaned[i][1] = cleaned[i - 1][1]
    if cleaned and cleaned[0][1] < 0:
        cleaned[0][1] = 0.0
    return cleaned


def group_lines(words):
    """Pack consecutive word indices into display lines (<=MAX_WORDS, <=MAX_CHARS, no long pause)."""
    lines, cur, cur_chars = [], [], 0
    for i, (w, onset) in enumerate(words):
        gap = onset - words[i - 1][1] if cur else 0
        add = len(w) + (1 if cur else 0)
        if cur and (len(cur) >= MAX_WORDS or cur_chars + add > MAX_CHARS or gap > GAP_BREAK):
            lines.append(cur); cur, cur_chars = [], 0
            add = len(w)
        cur.append(i); cur_chars += add
    if cur:
        lines.append(cur)
    return lines


def main():
    src, dst = sys.argv[1], sys.argv[2]
    outro_start = float(sys.argv[3]) if len(sys.argv) > 3 else 1e9
    highlight = hex_to_ass(sys.argv[4] if len(sys.argv) > 4 else None)

    words = []
    try:
        with open(src) as f:
            data = json.load(f)
        words = extract_words(data.get("transcription", []))
    except Exception:
        words = []

    # Apply outro cutoff.
    words = [w for w in words if w[1] < outro_start]
    n = len(words)

    # Each word ends where the next word begins, so exactly one event renders at
    # any instant (no overlap -> libass never stacks two lines). The last word of
    # a line lingers across a pause but is capped and cut a hair before the next
    # line; the very last word of the clip lingers TAIL_DUR.
    lines = group_lines(words)
    events = []
    for line in lines:
        toks = [words[k][0] for k in line]
        for pos, k in enumerate(line):
            ws = words[k][1]
            if pos + 1 < len(line):                  # mid-line: end at next word onset
                we = words[k + 1][1]
            elif k + 1 < n:                           # line end: linger to next line, capped
                we = min(words[k + 1][1] - EPS, ws + MAX_TAIL)
            else:                                     # very last word of the clip
                we = ws + TAIL_DUR
            we = min(we, outro_start)
            if we <= ws:
                we = ws + MIN_WORD_DUR
            parts = []
            for j, tok in enumerate(toks):
                if j == pos:
                    parts.append("{\\c" + highlight + "}" + tok + "{\\c" + WHITE + "}")
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
            # Pin every line to an absolute bottom-center position so multi-line vs single-line
            # captions never shift up/down (the reported "caption goes up then comes down").
            f.write(f"Dialogue: 0,{ass_time(ws)},{ass_time(we)},Cap,,0,0,0,,{{\\pos({PLAY_W//2},{PLAY_H-MARGIN_V})}}{text}\n")


if __name__ == "__main__":
    main()
