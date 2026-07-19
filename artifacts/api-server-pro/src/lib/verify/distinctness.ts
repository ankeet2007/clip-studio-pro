// Visual distinctness — stops the same-looking footage being used twice.
//
// WHY THIS EXISTS. Two renders shipped with visibly repeated footage:
//   v2: one clip used as the base for 3 beats, another for 2.
//   v3: three CONSECUTIVE windows of one 77s clip — [18-36], [36-54], [54-72] — all from the same
//       passage of play around the 65th minute, same camera, same celebration.
//
// v3 passed the rule that was in place, because the rule was "windows must not overlap". Measured
// afterwards on the rendered output, two frames FOUR SECONDS APART scored 100% identical on an 8x8
// perceptual hash, and 10 of 105 frame pairs across the whole video scored >=85%.
//
// So: non-overlapping is not distinct, and "distinct" has to be MEASURED rather than assumed. That
// mistake is the reason this module exists instead of a comment telling a human to check.
//
// The pure half (hashing comparison, pair-finding, adjacency) is unit-tested; only frame extraction
// touches ffmpeg.

import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Similarity above which two windows count as the same footage.
 *
 * Calibrated on the v3 render, not guessed: the pair that shipped scored 100%, and the cluster of
 * genuinely-too-similar pairs sat at 89-100%. Distinct beats in the same video scored well below.
 * 85% sits under that cluster with margin.
 */
export const DUPLICATE_THRESHOLD = 0.85;

/**
 * Minimum gap between two windows taken from the SAME source file.
 *
 * Consecutive slices of one continuous passage are near-identical by construction — that is exactly
 * what v3 did. Even when the hash happens to differ, footage 8 seconds apart in one shot reads as
 * the same shot to a viewer.
 */
export const MIN_SAME_SOURCE_GAP_SEC = 25;

export interface WindowRef {
  /** Beat number or any caller-side identifier, used in violation messages. */
  id: string | number;
  source: string;
  start: number;
  end: number;
  /** One aHash per sampled frame, as bit arrays. */
  hashes: number[][];
}

export interface Violation {
  a: string | number;
  b: string | number;
  reason: string;
  similarity?: number;
}

/** Fraction of identical bits between two hashes. PURE. */
export function hashSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

/**
 * Similarity between two WINDOWS = the MAXIMUM similarity of any frame pair across them.
 *
 * Max, not mean, on purpose: if any sampled moment of window A looks like any sampled moment of
 * window B, a viewer will see the repeat. Averaging hides exactly the case we care about — one
 * shared shot inside two otherwise different windows.
 */
export function windowSimilarity(a: WindowRef, b: WindowRef): number {
  let worst = 0;
  for (const ha of a.hashes) {
    for (const hb of b.hashes) {
      const s = hashSimilarity(ha, hb);
      if (s > worst) worst = s;
    }
  }
  return worst;
}

/**
 * Check a whole proposed assignment. Returns every violation, not just the first — a caller fixing
 * one beat should be told about the others in the same pass.
 */
export function checkDistinct(
  windows: WindowRef[],
  threshold = DUPLICATE_THRESHOLD,
  minGapSec = MIN_SAME_SOURCE_GAP_SEC,
): Violation[] {
  const out: Violation[] = [];
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i]!, b = windows[j]!;

      // Same file, and the windows sit close together in it.
      if (a.source === b.source) {
        const gap = a.start < b.start ? b.start - a.end : a.start - b.end;
        if (gap < minGapSec) {
          out.push({
            a: a.id, b: b.id,
            reason: `same source, only ${Math.max(0, gap).toFixed(1)}s apart — consecutive slices of one passage look identical (needs ${minGapSec}s)`,
          });
          continue; // adjacency already condemns it; no need to also report similarity
        }
      }

      const sim = windowSimilarity(a, b);
      if (sim >= threshold) {
        out.push({
          a: a.id, b: b.id, similarity: sim,
          reason: `visually ${(sim * 100).toFixed(0)}% identical (limit ${(threshold * 100) | 0}%)`,
        });
      }
    }
  }
  return out;
}

// ---- I/O below ----

/** Average-hash a single frame file: 8x8 grayscale, bit per pixel vs the mean. */
async function hashFrame(jpg: string, tmpDir: string): Promise<number[] | null> {
  const raw = path.join(tmpDir, `${path.basename(jpg)}.raw`);
  try {
    await execFileAsync("ffmpeg", ["-v", "error", "-i", jpg, "-vf", "scale=8:8,format=gray", "-f", "rawvideo", "-y", raw], { timeout: 15_000 });
    const b = fs.readFileSync(raw);
    if (b.length < 64) return null;
    const bytes = Array.from(b.subarray(0, 64));
    const avg = bytes.reduce((x, y) => x + y, 0) / bytes.length;
    return bytes.map((v) => (v > avg ? 1 : 0));
  } catch {
    return null;
  }
}

/** Sample a window and hash the frames. `-ss` before `-i` = input seek, ~1s per frame. */
export async function hashWindow(source: string, start: number, end: number, frames = 3): Promise<number[][]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dist_"));
  const out: number[][] = [];
  try {
    const span = Math.max(0.1, end - start);
    for (let i = 0; i < frames; i++) {
      const t = start + (span * (i + 0.5)) / frames;
      const jpg = path.join(dir, `f${i}.jpg`);
      try {
        await execFileAsync("ffmpeg", ["-v", "error", "-ss", t.toFixed(2), "-i", source, "-vf", "scale=160:-2", "-frames:v", "1", "-update", "1", "-y", jpg], { timeout: 20_000 });
        const h = await hashFrame(jpg, dir);
        if (h) out.push(h);
      } catch { /* one missing frame is survivable */ }
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
  return out;
}
