import re, sys

def srt_time_to_sec(t):
    h, m, s = t.strip().split(':')
    return int(h)*3600 + int(m)*60 + float(s.replace(',','.'))

def sec_to_srt_time(s):
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = s % 60
    return f"{h:02d}:{m:02d}:{sec:06.3f}".replace('.', ',')

src, dst = sys.argv[1], sys.argv[2]
outro_start = float(sys.argv[3]) if len(sys.argv) > 3 else 9999

with open(src) as f: content = f.read()
blocks = content.strip().split('\n\n')

# Pass 1: parse every cue and strip non-speech / dash markers from its text.
cues = []
for block in blocks:
    lines = block.strip().split('\n')
    if len(lines) < 3: continue
    times = lines[1].split(' --> ')
    start_sec = srt_time_to_sec(times[0])
    end_sec = srt_time_to_sec(times[1])
    filtered = []
    for line in lines[2:]:
        line = re.sub(r'[\(\[].*?[\)\]]', '', line)   # drop (sighs), [music], etc.
        line = re.sub(r'^\s*-\s*', '', line)
        line = line.strip()
        if line:
            filtered.append(line)
    if filtered and end_sec > start_sec:
        cues.append([start_sec, end_sec, filtered])

# Pass 2: clamp overlaps so no two cues are ever on screen at once. whisper can
# emit cues whose times overlap, which makes libass stack them into a garbled
# double line — clamp each cue to end just before the next one starts.
cues.sort(key=lambda c: c[0])
GAP = 0.04
for j in range(len(cues) - 1):
    if cues[j][1] > cues[j + 1][0] - GAP:
        cues[j][1] = max(cues[j][0], cues[j + 1][0] - GAP)

# Pass 3: apply the outro cutoff and write out renumbered, non-overlapping cues.
out = []
i = 1
for start_sec, end_sec, filtered in cues:
    if start_sec >= outro_start: continue
    if end_sec > outro_start:
        end_sec = outro_start
    if end_sec <= start_sec: continue
    out.append(str(i))
    out.append(f"{sec_to_srt_time(start_sec)} --> {sec_to_srt_time(end_sec)}")
    out.extend(filtered)
    out.append('')
    i += 1

with open(dst, 'w') as f: f.write('\n'.join(out))
