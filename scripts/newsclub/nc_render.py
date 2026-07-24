#!/usr/bin/env python3
"""NewsClub render builder — Direction B (Editorial Clean · Deep Indigo).

Successor to the ad-hoc render_gen.py. Given the footage segments, per-beat
metadata (kicker + source + time range), the narration script, and the VO, it:
  * generates the chrome overlays via nc_brand (wordmark / scrim / progress /
    per-beat kicker + source),
  * writes captions.ass (speech-flow timing + one indigo-highlighted word per line),
  * emits job.json (an ffmpeg filter_complex, RELATIVE paths) for the Colab
    /worker/ffmpeg-job, matching the approved Direction-B look.

`python3 nc_render.py --selftest` renders a short local preview frame to verify.
"""
import os, re, json, sys, subprocess, shutil
import nc_brand as brand
from nc_brand import W, H, PAD, SAFE_X, GLOW, FONT
from PIL import Image

KICK_Y = int(H * 0.64)          # kicker content top
CAP_Y  = 1300                   # caption top (just below kicker), pinned via \pos
SRC_Y  = int(H * 0.85)          # source tag content top
GLOW_ASS = "&HFF9882&"          # GLOW rgb(130,152,255) as ASS &HBBGGRR
CAPTION_FONT = "Inter"          # family; fontsdir points at ./fonts (falls back to DejaVu Sans)

STOP = set("the a an and or but of to in on at for with as by it its it's he she they them his "
           "her their our your was were is are be been that this these those then than into from "
           "over after before not no so up out who what when where would will shall had has have "
           "did do down now we you i me my am also and's about".split())

# ---------------- captions (speech-flow + highlight) ----------------
def _speech_intervals(total, sil_text):
    if not sil_text:
        return [(0.0, total)]
    gs = [float(x) for x in re.findall(r'silence_start=([\d.]+)', sil_text)]
    ge = [float(x) for x in re.findall(r'silence_end=([\d.]+)', sil_text)]
    speech, cur = [], 0.0
    for a, b in sorted(zip(gs, ge)):
        a = max(0.0, a); b = min(total, b)
        if a > cur: speech.append((cur, a))
        cur = max(cur, b)
    if cur < total: speech.append((cur, total))
    return speech or [(0.0, total)]

def _ts(t):
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"

def _pick_hl(words):
    best, bi = 0, None
    for i, w in enumerate(words):
        cw = re.sub(r'[^A-Za-z]', '', w)
        if cw.lower() in STOP or len(cw) < 4: continue
        if len(cw) > best: best, bi = len(cw), i
    return bi

def build_ass(script, total, sil_text=None, path=None, chunk=4):
    speech = _speech_intervals(total, sil_text)
    sdur = sum(b - a for a, b in speech)
    def wall(p):
        acc = 0.0
        for a, b in speech:
            if acc + (b - a) >= p: return a + (p - acc)
            acc += b - a
        return speech[-1][1]
    words = script.split()
    cum = [0]
    for w in words: cum.append(cum[-1] + len(w) + 1)
    tot = cum[-1]
    A = ["[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920",
         "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
         "[V4+ Styles]",
         "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
         "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
         "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
         f"Style: NC,{CAPTION_FONT},52,&H00FFFFFF,&H000000FF,&H00000000,&H50000000,0,0,0,0,"
         "100,100,0,0,1,2,2,7,72,72,300,1", "",
         "[Events]",
         "Format: Layer, Start, End, Style, Name, MarginL, MarginR, Effect, Text"]
    i = 0
    while i < len(words):
        j = min(i + chunk, len(words))
        grp = words[i:j]
        s0 = wall(cum[i] / tot * sdur); s1 = wall(cum[j] / tot * sdur)
        hl = _pick_hl(grp)
        parts = []
        for k, w in enumerate(grp):
            parts.append(f"{{\\c{GLOW_ASS}}}{w}{{\\c&HFFFFFF&}}" if k == hl else w)
        text = "{\\an7\\pos(72,%d)}" % CAP_Y + " ".join(parts)
        A.append(f"Dialogue: 0,{_ts(s0)},{_ts(s1)},NC,,0,0,,{text}")
        i = j
    if path: open(path, "w").write("\n".join(A))
    return "\n".join(A)

# ---------------- footage segment chains (ported from render_gen) ----------------
def seg_chain(idx, treat, dur, is_img):
    v = f"[{idx}:v]"
    pre = "" if is_img else f"trim=0:{dur:.3f},setpts=PTS-STARTPTS,"
    cov = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"
    if treat == "cover":     body = cov
    elif treat == "bands":   body = f"crop=iw:ih*0.74:0:ih*0.10,{cov}"
    elif treat == "bottomhalf": body = f"crop=iw:ih/2:0:ih/2,{cov}"
    elif treat == "topcrop": body = f"crop=iw:ih*0.90:0:ih*0.10,{cov}"
    elif treat == "fitblur":
        return (f"{v}{pre}split=2[b{idx}][f{idx}];"
                f"[b{idx}]{cov},gblur=sigma=28[bg{idx}];"
                f"[f{idx}]scale=1080:1920:force_original_aspect_ratio=decrease[fg{idx}];"
                f"[bg{idx}][fg{idx}]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,format=yuv420p[v{idx}]")
    else: body = cov
    return f"{v}{pre}{body},setsar=1,fps=30,format=yuv420p[v{idx}]"

# ---------------- chrome overlays ----------------
def write_chrome(beats, workdir):
    """Render the overlay PNGs into workdir; return the ordered list of image files.
    Also copies the caption font into workdir so the bundle's `subtitles=...:fontsdir=.`
    resolves it on the Colab worker (same mechanism clips 4/5 used with Anton)."""
    shutil.copy(FONT, os.path.join(workdir, os.path.basename(FONT)))
    brand.scrim().save(os.path.join(workdir, "scrim.png"))
    brand.wordmark().save(os.path.join(workdir, "wordmark.png"))
    Image.new("RGBA", (W, 6), GLOW + (255,)).save(os.path.join(workdir, "prog.png"))
    files = ["scrim.png", "prog.png", "wordmark.png"]
    for i, b in enumerate(beats):
        brand.kicker(b["kicker"]).save(os.path.join(workdir, f"kicker{i}.png"))
        brand.source_tag(b["source"]).save(os.path.join(workdir, f"source{i}.png"))
        files += [f"kicker{i}.png", f"source{i}.png"]
    return files

def chrome_filter(vin, base_idx, beats, total):
    """Overlay chrome onto video label `vin`. Overlay inputs start at base_idx
    in the order scrim, prog, wordmark, [kicker_i, source_i]..."""
    p = [f"[{vin}][{base_idx}:v]overlay=0:0[cx0]",
         f"[cx0][{base_idx+1}:v]overlay=x='W*(t/{total}-1)':y=0[cx1]",
         f"[cx1][{base_idx+2}:v]overlay=x=(W-w)/2:y={54-PAD}[cx2]"]
    lbl, k = "cx2", base_idx + 3
    for i, b in enumerate(beats):
        t0, t1 = b["t0"], b["t1"]; fo = max(t0, t1 - 0.3)
        p.append(f"[{k}:v]format=rgba,fade=in:st={t0}:d=0.3:alpha=1,fade=out:st={fo:.2f}:d=0.3:alpha=1[kf{i}]")
        p.append(f"[{lbl}][kf{i}]overlay=x={SAFE_X-PAD+14}:y={KICK_Y-PAD}:enable='between(t,{t0},{t1})'[kb{i}]")
        p.append(f"[{k+1}:v]format=rgba,fade=in:st={t0}:d=0.3:alpha=1,fade=out:st={fo:.2f}:d=0.3:alpha=1[sf{i}]")
        p.append(f"[kb{i}][sf{i}]overlay=x=W-w-{SAFE_X-PAD}:y={SRC_Y-PAD}:enable='between(t,{t0},{t1})'[cb{i}]")
        lbl, k = f"cb{i}", k + 2
    return p, lbl

# ---------------- full job ----------------
def build_job(segments, beats, script, total, audio, workdir, sil_text=None):
    os.makedirs(workdir, exist_ok=True)
    imgs = write_chrome(beats, workdir)
    build_ass(script, total, sil_text, os.path.join(workdir, "captions.ass"))
    S = len(segments); base = S                      # overlay imgs after segments
    chains = [seg_chain(i, t, d, im) for i, (f, im, d, t) in enumerate(segments)]
    concat_in = "".join(f"[v{i}]" for i in range(S))
    cf, last = chrome_filter("vcat", base, beats, total)
    aud_idx = S + len(imgs)
    graph = (";".join(chains) + ";" + concat_in + f"concat=n={S}:v=1:a=0[vcat];"
             + ";".join(cf) + f";[{last}]subtitles=captions.ass:fontsdir=.[vout]"
             + f";[{aud_idx}:a]loudnorm=I=-14:TP=-1.5:LRA=11[aout]")
    args = ["-y"]
    for f, im, d, t in segments:
        args += (["-loop", "1", "-t", f"{d:.3f}", "-i", f] if im else ["-i", f])
    for name in imgs:
        args += ["-loop", "1", "-t", f"{total:.3f}", "-i", name]
    args += ["-i", audio, "-filter_complex", graph, "-map", "[vout]", "-map", "[aout]",
             "-c:v", "libx265", "-preset", "veryfast", "-crf", "22", "-tag:v", "hvc1",
             "-maxrate", "4000k", "-bufsize", "8000k", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-t", f"{total:.2f}", "out.mp4"]
    json.dump({"args": args, "output": "out.mp4"}, open(os.path.join(workdir, "job.json"), "w"))
    return graph

# ---------------- self-test ----------------
def _selftest():
    wd = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "selftest")
    os.makedirs(wd, exist_ok=True)
    total = 6.0
    beats = [{"kicker": "Modi breaks silence", "source": "via X · @user", "t0": 0.3, "t1": total}]
    script = "Modi called it a grave sin and vowed fast track courts for the accused"
    brand._placeholder_footage().convert("RGB").save(os.path.join(wd, "ph.png"))
    imgs = write_chrome(beats, wd)
    build_ass(script, total, None, os.path.join(wd, "captions.ass"))
    cf, last = chrome_filter("vcat", 1, beats, total)   # base=1 (input0 is placeholder)
    graph = (f"[0:v]scale=1080:1920,setsar=1,fps=30,format=yuv420p[vcat];"
             + ";".join(cf) + f";[{last}]subtitles=captions.ass:fontsdir=.[vout]")
    args = ["ffmpeg", "-y", "-loop", "1", "-t", "3", "-i", "ph.png"]
    for name in imgs: args += ["-loop", "1", "-t", "3", "-i", name]
    args += ["-filter_complex", graph, "-map", "[vout]", "-r", "30", "-t", "3",
             "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "clip.mp4"]
    print("running local ffmpeg smoke-test...")
    r = subprocess.run(args, cwd=wd, capture_output=True, text=True)
    if r.returncode != 0:
        print("FFMPEG FAILED:\n", r.stderr[-1800:]); return
    subprocess.run(["ffmpeg", "-y", "-ss", "2.4", "-i", "clip.mp4", "-frames:v", "1",
                    "-vf", "scale=540:960", "frame.png"], cwd=wd, capture_output=True, text=True)
    print("OK ->", os.path.join(wd, "frame.png"))

if __name__ == "__main__":
    if "--selftest" in sys.argv: _selftest()
    else: print("import as a module, or run with --selftest")
