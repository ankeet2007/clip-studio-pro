// Spine transcription — building the moment index from a highlight's commentary.
//
// ── WHY NOT WHISPER ───────────────────────────────────────────────────────────────────────
// The original design chunked the spine audio and ran whisper medium.en on the Colab worker.
// Measured, that is ~20-30s per 60s chunk, and Colab is 2-core so the chunks MUST run strictly
// sequentially — two concurrent jobs both hit a silent 280s timeout. A 10-minute highlight
// therefore cost ~4-5 minutes and was the slowest, most fragile part of the pipeline.
//
// Measured head-to-head on the SAME 60s of real commentary:
//   whisper medium.en : "Killian Mbappe ... as Les Blue SUBMERGED from the interval"   ~25s
//   gemini-3.1-flash-lite: "Kylian Mbappé ... as Les Bleus EMERGED from the interval"   5.2s
//
// Whisper got the name wrong, the French wrong, and inverted an actual word. That is not a
// cosmetic difference here: the moment index is searched by NAME, so a transcript reading
// "Killian Mbappe" silently breaks every lookup for "Mbappé". Proper-noun fidelity is the
// whole product requirement, and Gemini is both better at it and ~5x faster.
//
// Whisper is still required for CAPTION timing (karaoke_captions_pro.py needs word-level DTW
// alignment); Gemini's timestamps are model-estimated and only good to the sentence. That is
// exactly the right precision for locating a moment, and the wrong precision for karaoke.

import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "../logger";
import type { MomentEntry } from "./momentIndex";

const execFileAsync = promisify(execFile);

/** Same quota-driven ladder as the verifier: flash-lite has 500 RPD vs 2.5-flash's 20. */
const TRANSCRIBE_MODELS = ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"];

/** Keep each request well inside the inline-payload limit. 16kbps opus ≈ 2KB/s, so 10 minutes
 *  is ~1.2MB — comfortable. Longer sources are split and the offsets re-based. */
const CHUNK_SEC = 600;

/** Extract mono 16kHz Opus — ~2KB/s, tiny enough to inline and lossless for speech. */
async function extractAudio(src: string, startSec: number, durSec: number, out: string): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", [
      "-v", "error", "-ss", String(startSec), "-t", String(durSec), "-i", src,
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "16k", "-y", out,
    ], { timeout: 180_000 });
    return fs.existsSync(out) && fs.statSync(out).size > 512;
  } catch (e) {
    logger.warn({ e, src: path.basename(src) }, "Spine audio extraction failed");
    return false;
  }
}

const PROMPT = [
  "Transcribe this sports commentary with TIMESTAMPS.",
  'Reply ONLY with a compact JSON array: [{"t":<seconds from the start of THIS audio>,"text":"<what is said>"}]',
  "One entry per sentence or distinct call. Spell player and team names CORRECTLY — the",
  "transcript is searched by name, so a misspelt name makes the moment unfindable.",
  "If nothing is said, reply [].",
].join("\n");

async function transcribeChunk(file: string, offsetSec: number): Promise<MomentEntry[] | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const b64 = fs.readFileSync(file).toString("base64");

  for (const model of TRANSCRIBE_MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: "audio/ogg", data: b64 } }] }],
            generationConfig: { temperature: 0 },
          }),
          signal: AbortSignal.timeout(180_000),
        },
      );
      if (res.status === 429) { logger.warn({ model }, "Transcribe quota exhausted — next model"); continue; }
      if (!res.ok) { logger.warn({ model, status: res.status }, "Transcribe call failed"); continue; }
      const j = await res.json() as any;
      const text: string = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("") ?? "";
      const m = text.match(/\[[\s\S]*\]/);
      if (!m) continue;
      const arr = JSON.parse(m[0]);
      if (!Array.isArray(arr)) continue;
      return arr
        .map((e: any) => ({ t: Number(e?.t) + offsetSec, text: String(e?.text ?? "").trim() }))
        .filter((e: MomentEntry) => Number.isFinite(e.t) && e.text.length > 0);
    } catch (e) {
      logger.warn({ e, model }, "Transcribe threw — next model");
    }
  }
  return null;
}

/**
 * Transcribe a whole spine into timestamped entries.
 *
 * Chunks run SEQUENTIALLY. Not for the Colab reason any more — this is a network call — but
 * because the free-tier RPM ceiling is low (15/min on flash-lite) and firing a long highlight's
 * chunks in parallel is the fastest way to eat a 429 mid-build.
 */
export async function transcribeSpine(videoPath: string, durationSec: number): Promise<MomentEntry[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spine_"));
  const entries: MomentEntry[] = [];
  try {
    for (let offset = 0; offset < durationSec; offset += CHUNK_SEC) {
      const len = Math.min(CHUNK_SEC, durationSec - offset);
      const audio = path.join(dir, `c${offset}.ogg`);
      if (!(await extractAudio(videoPath, offset, len, audio))) continue;
      const part = await transcribeChunk(audio, offset);
      if (part) entries.push(...part);
      try { fs.unlinkSync(audio); } catch { /* */ }
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
  entries.sort((a, b) => a.t - b.t);
  logger.info({ video: path.basename(videoPath), entries: entries.length, durationSec }, "Spine transcribed");
  return entries;
}
