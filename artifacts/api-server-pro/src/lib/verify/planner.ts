// The PLANNER — one decision that assigns every beat, instead of six independent guesses.
//
// WHY THIS EXISTS. Scout ranks candidates INDEPENDENTLY and something downstream then picks a
// clip per beat. That is structurally incapable of two things the story needs:
//
//   1. NO REPETITION. A greedy per-beat pick has no idea beat 5 already used the clip beat 1
//      used. The first shipped attempt reused one clip for three beats and another for two.
//   2. COVERAGE. Deciding beat-by-beat cannot reason "clip 7 is the only footage of Mbappé
//      scoring, so it must go to the beat about him scoring, not the beat about statistics".
//
// Both are GLOBAL constraints, so they need a global decision. The planner shows one model the
// whole script and every candidate at once — with real keyframes, because the failure that
// caused this was a clip whose title matched perfectly and whose CONTENT did not.
//
// The model proposes; the server DISPOSES. Every returned assignment is validated here against
// hard rules (clip exists, base long enough, no reuse) — a plan is a suggestion, not permission.

import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "../logger";

const execFileAsync = promisify(execFile);

const PLANNER_MODELS = ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"];

export interface PlanCandidate {
  /** 1-based id shown to the model. */
  n: number;
  path: string;
  durationSec: number;
  note?: string;
}

export interface PlanBeat {
  /** 1-based beat index. */
  n: number;
  narration: string;
  /** Seconds of speech this beat needs — the base clip must be at least this long. */
  needsSec: number;
}

export interface Assignment {
  beat: number;
  candidate: number;
  start: number;
  end: number;
  why: string;
  warning?: string;
}

/** Sample frames across a candidate so the model judges CONTENT, not metadata. */
async function sampleFrames(file: string, durationSec: number, n = 3): Promise<{ t: number; b64: string }[]> {
  const out: { t: number; b64: string }[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan_"));
  try {
    for (let i = 0; i < n; i++) {
      const t = (durationSec * (i + 0.5)) / n;
      const f = path.join(dir, `f${i}.jpg`);
      try {
        await execFileAsync("ffmpeg", [
          "-v", "error", "-ss", t.toFixed(2), "-i", file,
          "-vf", "scale=512:-2", "-frames:v", "1", "-update", "1", "-y", f,
        ], { timeout: 20_000 });
        if (fs.existsSync(f)) out.push({ t, b64: fs.readFileSync(f).toString("base64") });
      } catch { /* one missing frame is survivable */ }
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
  return out;
}

function buildPrompt(beats: PlanBeat[], cands: PlanCandidate[]): string {
  return [
    "You are choosing the footage for a vertical short-form video. You will see the full script",
    "and EVERY available clip, sampled as frames with the timestamp of each frame.",
    "",
    "SCRIPT — one beat per line, with the minimum clip length that beat needs:",
    ...beats.map((b) => `  BEAT ${b.n} (needs >= ${b.needsSec.toFixed(1)}s): ${b.narration}`),
    "",
    "AVAILABLE CLIPS:",
    ...cands.map((c) => `  CLIP ${c.n}: ${c.durationSec.toFixed(1)}s long${c.note ? ` — ${c.note}` : ""}`),
    "",
    "Assign ONE clip and ONE time window to each beat. Rules, in priority order:",
    "1. CONTENT MUST MATCH THE WORDS. If a beat says a player scored, its footage must show that",
    "   player or that goal — not generic play, not post-match, not the other team celebrating.",
    "   Judge from the FRAMES, never from what a clip is called.",
    "2. NEVER use the same clip for two beats. If there are fewer clips than beats, say so in",
    "   `unassignable` rather than repeating one — repetition is worse than an honest gap.",
    "3. The window MUST be at least the beat's required length, and inside the clip's duration.",
    "4. Pick the window whose FRAMES show the moment — use the frame timestamps to place it.",
    "5. Prefer variety: different camera angles and scenes across consecutive beats.",
    "",
    'Reply ONLY with compact JSON:',
    '{"assignments":[{"beat":1,"candidate":3,"start":12.0,"end":28.0,"why":"<8 words>"}],',
    '"unassignable":[{"beat":5,"reason":"no clip shows this"}]}',
  ].join("\n");
}

/**
 * Ask the model to plan the whole video. Returns validated assignments only.
 *
 * Validation is not a formality: a model can hallucinate a clip number, exceed a clip's
 * duration, or quietly reuse one. Those are exactly the failures we are trying to remove, so
 * they are enforced here rather than trusted.
 */
export async function planBeats(
  beats: PlanBeat[],
  cands: PlanCandidate[],
): Promise<{ assignments: Assignment[]; unassignable: { beat: number; reason: string }[]; note?: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { assignments: [], unassignable: beats.map((b) => ({ beat: b.n, reason: "no vision model configured" })), note: "GEMINI_API_KEY not set" };

  const parts: any[] = [{ text: buildPrompt(beats, cands) }];
  for (const c of cands) {
    const frames = await sampleFrames(c.path, c.durationSec);
    parts.push({ text: `\nCLIP ${c.n} frames (at ${frames.map((f) => f.t.toFixed(1) + "s").join(", ")}):` });
    for (const f of frames) parts.push({ inline_data: { mime_type: "image/jpeg", data: f.b64 } });
  }

  for (const model of PLANNER_MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0 } }),
          signal: AbortSignal.timeout(180_000),
        },
      );
      if (res.status === 429) { logger.warn({ model }, "Planner quota exhausted — next model"); continue; }
      if (!res.ok) { logger.warn({ model, status: res.status }, "Planner call failed"); continue; }
      const j = await res.json() as any;
      const text: string = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("") ?? "";
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) continue;
      const parsed = JSON.parse(m[0]);

      const used = new Set<number>();
      const assignments: Assignment[] = [];
      const unassignable: { beat: number; reason: string }[] = Array.isArray(parsed.unassignable) ? parsed.unassignable : [];

      for (const a of (parsed.assignments ?? [])) {
        const beat = beats.find((b) => b.n === Number(a?.beat));
        const cand = cands.find((c) => c.n === Number(a?.candidate));
        if (!beat || !cand) { unassignable.push({ beat: Number(a?.beat) || 0, reason: "planner named a clip that does not exist" }); continue; }
        if (used.has(cand.n)) { unassignable.push({ beat: beat.n, reason: `planner reused clip ${cand.n} — refused` }); continue; }

        let start = Math.max(0, Number(a?.start) || 0);
        let end = Number(a?.end) || 0;
        if (end <= start) end = start + beat.needsSec;
        // Grow or slide the window so the base is never shorter than the narration — a short
        // base makes the voice bleed into the next beat, which reads as an echo.
        if (end - start < beat.needsSec) end = start + beat.needsSec;
        if (end > cand.durationSec) { end = cand.durationSec; start = Math.max(0, end - beat.needsSec); }
        if (end - start < beat.needsSec - 0.05) { unassignable.push({ beat: beat.n, reason: `clip ${cand.n} is too short for this beat` }); continue; }

        used.add(cand.n);
        assignments.push({ beat: beat.n, candidate: cand.n, start, end, why: String(a?.why ?? "").slice(0, 80) });
      }

      assignments.sort((x, y) => x.beat - y.beat);
      logger.info({ model, assigned: assignments.length, unassignable: unassignable.length }, "Beat plan complete");
      return { assignments, unassignable };
    } catch (e) {
      logger.warn({ e, model }, "Planner threw — next model");
    }
  }
  return { assignments: [], unassignable: beats.map((b) => ({ beat: b.n, reason: "planner unavailable" })) };
}
