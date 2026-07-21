#!/usr/bin/env python3
# VL-screen a clip: sample frames, ask a free vision model whether it's real footage and whether it
# has burned-in text (subtitles/chyrons/ads). Falls back across models/providers on 429/502 so a
# single flaky free endpoint never blocks the screen. Usage: vl_screen.py <clip.mp4> [t1 t2 ...]
import sys, os, base64, json, subprocess, tempfile, urllib.request, urllib.error, time

KEY = None
with open(os.path.expanduser("~/myapp/openrouter.env")) as f:
    for line in f:
        if line.startswith("OPENROUTER_API_KEY="):
            KEY = line.strip().split("=", 1)[1]

MODELS = [
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "google/gemma-4-26b-a4b-it:free",
    "nvidia/nemotron-nano-12b-v2-vl:free",
]
PROMPT = (
    "Look at this frame from a sports clip. Reply in EXACTLY this format, nothing else:\n"
    "REAL: <yes if genuine broadcast/match footage; no if talking-head/studio-panel/cartoon/graphic/meme>\n"
    "BURNED_TEXT: <list every burned-in subtitle, caption, chyron, scoreboard or ad text; write 'none' "
    "if there is only a small corner logo/handle watermark>\n"
    "SHOWS: <one short line: which players/teams and the action>"
)

def frame_b64(clip, t):
    fd, p = tempfile.mkstemp(suffix=".jpg"); os.close(fd)
    subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t), "-i", clip, "-vf", "scale=768:-2",
                    "-frames:v", "1", "-update", "1", "-y", p], timeout=30)
    b = base64.b64encode(open(p, "rb").read()).decode()
    os.remove(p); return b

def ask(b64):
    for model in MODELS:
        for attempt in range(2):
            payload = {"model": model, "max_tokens": 500, "temperature": 0, "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": PROMPT},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}]}]}
            req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions",
                data=json.dumps(payload).encode(),
                headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
            try:
                d = json.load(urllib.request.urlopen(req, timeout=90))
                c = (d.get("choices", [{}])[0].get("message", {}) or {}).get("content")
                if c and c.strip():
                    return model.split("/")[-1], c.strip()
            except urllib.error.HTTPError as e:
                if e.code in (429, 502, 503): time.sleep(3); continue
            except Exception:
                time.sleep(2); continue
    return None, None

clip = sys.argv[1]
times = [float(x) for x in sys.argv[2:]] or [4, 10]
print(f"### {os.path.basename(clip)}")
for t in times:
    m, ans = ask(frame_b64(clip, t))
    if ans:
        print(f"[t={t}s via {m}]"); print("  " + ans.replace("\n", "\n  "))
    else:
        print(f"[t={t}s] all vision models unavailable (rate-limited)")
