#!/usr/bin/env python3
"""Thorough test of the NewsClub kit: static overflow checks + a full build_job render."""
import os, json, subprocess, sys
import nc_brand as brand
import nc_render as R
from nc_brand import W, SAFE_X, font
from PIL import ImageDraw, Image

HERE = os.path.dirname(os.path.abspath(__file__))
WD = os.path.join(HERE, "out", "fulltest")
os.makedirs(WD, exist_ok=True)
SAFE_W = W - 2 * SAFE_X            # 936px usable
bugs = []

# real clip-5 script (a chunk with some wide word-groups)
SCRIPT = ("On the twenty-third of July the protest at Jantar Mantar didn't fade it exploded "
          "into one of the biggest movements India has seen in years Prime Minister Narendra "
          "Modi finally broke his silence and announced fast track courts for the accused")
BEATS_LABELS = ["Modi breaks silence", "Police crackdown", "Education Secretary removed",
                "Wangchuk ends hunger strike", "Nationwide protest planned"]

print("=== 1. caption chunk width check (Inter 52, safe %dpx) ===" % SAFE_W)
d = ImageDraw.Draw(Image.new("RGBA", (10, 10)))
cf = font(52, "Medium")
words = SCRIPT.split()
worst = 0
for i in range(0, len(words), 4):
    grp = " ".join(words[i:i + 4])
    w = d.textlength(grp, font=cf); worst = max(worst, w)
    flag = "  <-- OVERFLOW" if w > SAFE_W else ""
    if w > SAFE_W: bugs.append(f"caption chunk overflows ({int(w)}px): '{grp}'")
    print(f"   {int(w):4d}px  {grp}{flag}")
print("   worst = %dpx" % worst)

print("=== 2. kicker label width check (safe %dpx) ===" % SAFE_W)
for lab in BEATS_LABELS:
    img = brand.kicker(lab)
    content = img.width - 2 * brand.PAD    # tick+label content width
    flag = "  <-- OVERFLOW" if content > SAFE_W else ""
    if content > SAFE_W: bugs.append(f"kicker overflows ({content}px): '{lab}'")
    print(f"   {content:4d}px  {lab}{flag}")

print("=== 3. full build_job render ===")
subprocess.run(["ffmpeg","-y","-f","lavfi","-i","testsrc2=s=720x1280:d=5:r=30",
                "-pix_fmt","yuv420p","-t","5","seg0.mp4"], cwd=WD, capture_output=True)
subprocess.run(["ffmpeg","-y","-f","lavfi","-i","color=c=0x102040:s=720x1280:d=4:r=30",
                "-pix_fmt","yuv420p","-t","4","seg1.mp4"], cwd=WD, capture_output=True)
subprocess.run(["ffmpeg","-y","-f","lavfi","-i","sine=f=200:d=9","audio.wav"], cwd=WD, capture_output=True)
segs = [("seg0.mp4", False, 5.0, "cover"), ("seg1.mp4", False, 4.0, "cover")]
beats = [{"kicker":"Modi breaks silence","source":"via X · @user","t0":0.3,"t1":5.0},
         {"kicker":"Education Secretary removed","source":"via X · @newsclub","t0":5.0,"t1":9.0}]
R.build_job(segs, beats, SCRIPT, 9.0, "audio.wav", WD)
job = json.load(open(os.path.join(WD, "job.json")))
n_inputs = sum(1 for a in job["args"] if a == "-i")
print("   job.json: %d inputs, %d args" % (n_inputs, len(job["args"])))
# local run: swap libx265->libx264 for speed / availability (Colab keeps x265)
args = ["ffmpeg"]
skip = False
for a in job["args"]:
    if a == "libx265": args.append("libx264"); continue
    if a == "-tag:v": skip = True; continue
    if skip: skip = False; continue
    args.append(a)
r = subprocess.run(args, cwd=WD, capture_output=True, text=True)
if r.returncode != 0:
    bugs.append("build_job ffmpeg FAILED"); print("   FFMPEG FAILED:\n", r.stderr[-2000:])
else:
    # validate: full decode + duration
    v = subprocess.run(["ffmpeg","-v","error","-i","out.mp4","-f","null","-"], cwd=WD, capture_output=True, text=True)
    if v.stderr.strip(): bugs.append("out.mp4 decode errors: " + v.stderr[:300])
    dur = subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0","out.mp4"],
                         cwd=WD, capture_output=True, text=True).stdout.strip()
    print("   out.mp4 OK, duration=%ss (want ~9)" % dur)
    for t in ("2.5", "6.5"):
        subprocess.run(["ffmpeg","-y","-ss",t,"-i","out.mp4","-frames:v","1","-vf","scale=540:960",
                        f"frame_{t}.png"], cwd=WD, capture_output=True)
    print("   frames: frame_2.5.png (beat1), frame_6.5.png (beat2)")

print("\n=== RESULT ===")
if bugs:
    print("BUGS FOUND:", len(bugs))
    for b in bugs: print(" -", b)
else:
    print("no bugs found")
