// The verifier — looks at frames and says what the footage actually shows.
//
// Deliberately does NOT transcribe. Transcription is what makes understand_video ~50s and
// forces sequential scheduling on the 2-core Colab box, and the failures this catches (a cat
// meme, a wrong-match chyron) are visible in a still frame. Cheap enough that verifying every
// beat is affordable, which is the only way verification can be made mandatory.
//
// Two backends, chosen at call time:
//   • gemini  — server-side, independent of whoever is driving the connector. Preferred.
//   • connector — no key available: return the frames to the caller as images and let it send
//     a verdict back via confirm_moment. Weaker (self-report) but the server still forces the
//     frames to be served and a verdict to be recorded, which is strictly better than prose.

import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "../logger";
import { putReceipt, type Receipt, type Verdict } from "./receipt";

const execFileAsync = promisify(execFile);

/**
 * Free-tier quota is the binding constraint, and it differs enormously by model:
 * gemini-2.5-flash allows 20 requests/DAY while gemini-3.1-flash-lite allows 500. Measured on
 * a real frame, flash-lite also read the burned-in banner MORE accurately ("ADI PREDICTOR" vs
 * "ADI PREDICT"). So flash-lite is primary; the others are fallbacks for a 429.
 */
export const VERIFY_MODELS = ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"];

const FRAMES_PER_BEAT = 3;

export interface VerifyRequest {
  /** Local uploads path (preferred — frame extraction is a fast local seek) . */
  asset: string;
  start: number;
  end: number;
  /** What the beat CLAIMS to show — the narration line or a description of the moment. */
  expect: string;
}

export interface VerifyOutcome {
  receipt: Receipt;
  /** Present only on the connector backend: frames for the caller to look at. */
  frames?: { mime: string; b64: string }[];
}

/**
 * Extract N frames spanning [start,end].
 *
 * `-ss` goes BEFORE `-i` on purpose: that is an input seek, so ffmpeg jumps straight to the
 * keyframe and decodes one frame (~1s). With `-ss` after `-i` it decodes everything from zero,
 * which on a 10-minute highlight takes minutes and will OOM the phone.
 */
async function extractFrames(asset: string, start: number, end: number, n = FRAMES_PER_BEAT): Promise<{ mime: string; b64: string }[]> {
  const out: { mime: string; b64: string }[] = [];
  const span = Math.max(0.1, end - start);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vfy_"));
  try {
    for (let i = 0; i < n; i++) {
      const t = start + (span * (i + 0.5)) / n;
      const f = path.join(dir, `f${i}.jpg`);
      try {
        await execFileAsync("ffmpeg", [
          "-v", "error", "-ss", t.toFixed(2), "-i", asset,
          "-vf", "scale=640:-2", "-frames:v", "1", "-update", "1", "-y", f,
        ], { timeout: 20_000 });
        if (fs.existsSync(f)) out.push({ mime: "image/jpeg", b64: fs.readFileSync(f).toString("base64") });
      } catch { /* a single missing frame is survivable */ }
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
  return out;
}

const PROMPT = [
  "You verify sports B-roll for a short-form video. For EACH numbered clip below you are given",
  "frames sampled across the exact window that will be rendered.",
  "",
  "Reply ONLY with a compact JSON array, one object per clip, in order:",
  '[{"n":1,"depicts":"<one short line>","onScreenText":["<every legible burned-in string>"],',
  '"matchesClaim":true|false,"flags":["slow-motion-replay"|"studio-talking-head"|"gameplay-render"|"static-graphic"]}]',
  "",
  "onScreenText matters as much as the action: read scoreboards, chyrons, tickers and captions",
  "verbatim, including team names and scorelines. Set matchesClaim=false if the frames do not",
  "show what the clip claims, or if they are not real broadcast/match footage at all.",
].join("\n");

/** Ask Gemini about a batch of clips in ONE call. Null when unavailable/failed (fail-open). */
async function askGemini(
  batch: { req: VerifyRequest; frames: { mime: string; b64: string }[] }[],
): Promise<{ depicts: string; onScreenText: string[]; matchesClaim: boolean; flags: string[] }[] | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const parts: any[] = [{ text: PROMPT }];
  batch.forEach((b, i) => {
    parts.push({ text: `\nCLIP ${i + 1} claims: ${b.req.expect}` });
    for (const f of b.frames) parts.push({ inline_data: { mime_type: f.mime, data: f.b64 } });
  });

  for (const model of VERIFY_MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0 } }),
          signal: AbortSignal.timeout(90_000),
        },
      );
      if (res.status === 429) { logger.warn({ model }, "Verifier quota exhausted — trying next model"); continue; }
      if (!res.ok) { logger.warn({ model, status: res.status }, "Verifier call failed"); continue; }
      const j = await res.json() as any;
      const text: string = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("") ?? "";
      const m = text.match(/\[[\s\S]*\]/);
      if (!m) { logger.warn({ model }, "Verifier returned no JSON array"); continue; }
      const arr = JSON.parse(m[0]);
      if (!Array.isArray(arr)) continue;
      logger.info({ model, clips: batch.length }, "Verifier batch complete");
      return arr.map((o: any) => ({
        depicts: String(o?.depicts ?? ""),
        onScreenText: Array.isArray(o?.onScreenText) ? o.onScreenText.map(String) : [],
        matchesClaim: o?.matchesClaim !== false,
        flags: Array.isArray(o?.flags) ? o.flags.map(String) : [],
      }));
    } catch (e) {
      logger.warn({ e, model }, "Verifier call threw — trying next model");
    }
  }
  return null;
}

/**
 * Verify a batch of beats and mint a receipt for each.
 *
 * Batching is what makes mandatory verification affordable: 6 beats = 18 frames = ONE model
 * call and one tunnel round trip, rather than six of each.
 *
 * FAIL-OPEN vs FAIL-CLOSED, deliberately asymmetric:
 *   • backend unreachable / quota exhausted ⇒ `unverified` receipt, render proceeds with a
 *     warning. An outage is not evidence about the footage.
 *   • backend answers "does not match" ⇒ `rejected` receipt, hard block, no override. A model
 *     verdict IS evidence.
 */
export async function verifyMoments(reqs: VerifyRequest[]): Promise<VerifyOutcome[]> {
  const batch = [];
  for (const req of reqs) batch.push({ req, frames: await extractFrames(req.asset, req.start, req.end) });

  const answers = await askGemini(batch);

  return batch.map((b, i) => {
    const a = answers?.[i];
    if (!a) {
      // No backend (no key) or the call failed — hand the frames back so the CONNECTOR can be
      // the verifier instead, and record a pending/unverified receipt either way.
      const receipt = putReceipt({
        asset: b.req.asset, windowStart: b.req.start, windowEnd: b.req.end,
        verdict: "unverified", onScreenText: [], depicts: "", flags: [],
        backend: "connector",
      });
      return { receipt, frames: b.frames };
    }
    const verdict: Verdict = a.matchesClaim ? "confirmed" : "rejected";
    const receipt = putReceipt({
      asset: b.req.asset, windowStart: b.req.start, windowEnd: b.req.end,
      verdict, onScreenText: a.onScreenText, depicts: a.depicts, flags: a.flags,
      backend: "gemini",
    });
    return { receipt };
  });
}
