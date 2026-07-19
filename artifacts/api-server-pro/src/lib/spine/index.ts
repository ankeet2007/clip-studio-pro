// Spine-first sourcing.
//
// Instead of hunting one clip per beat — six independent chances to get the match, era, moment
// or sharpness wrong — source ONE official broadcast highlight and cut every beat out of it.
// Era, match identity and sharpness then hold BY CONSTRUCTION for all beats at once, and
// locating each moment becomes a text search over the commentary (see momentIndex.ts).
//
// ⚠️ THE TRADE, stated plainly: this concentrates failure. A wrong spine makes EVERY beat wrong
// simultaneously, which is a worse failure MODE than per-beat hunting even though it has a much
// lower failure RATE. That is why spine selection carries the strictest bar in the system and
// the one verification that is never allowed to fail open.

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "../logger";
import { downloadClipToUploads, extractSegment } from "../videoUnderstand";
import { probeFootage } from "../footageQuality";
import { classifyUploader } from "../scout/sources";
import { probeCandidate } from "../scout/probe";
import { findYtDlp } from "../clipProcessor";
import { verifyMoments } from "../verify/verifier";
import { putReceipt } from "../verify/receipt";
import { transcribeSpine } from "./transcribe";
import { findMoment, type SpineIndex, type MomentHit } from "./momentIndex";

const execFileAsync = promisify(execFile);

/** Selection bar for a spine. Deliberately far stricter than the per-beat floors: a bad spine
 *  poisons the whole video, so we would rather return "no spine" and fall back to hunting. */
export const SPINE_MIN_DURATION_SEC = 180;
export const SPINE_MIN_BPP = 0.03;

export interface Spine {
  spineId: string;
  videoPath: string;
  sourceUrl: string;
  uploader: string;
  durationSec: number;
  index: SpineIndex;
  createdAt: number;
}

const spines = new Map<string, Spine>();
const SPINE_TTL_MS = 3 * 3600_000;

export function getSpine(id: string): Spine | undefined {
  const s = spines.get(id);
  if (!s) return undefined;
  if (Date.now() - s.createdAt > SPINE_TTL_MS) { spines.delete(id); return undefined; }
  return s;
}

/** Scene-cut detection over the whole file — the boundaries a moment gets snapped back to. */
async function detectScenes(videoPath: string, budgetMs = 120_000): Promise<number[]> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-v", "info", "-i", videoPath,
      "-vf", "scale=192:-2,select='gt(scene,0.30)',showinfo", "-f", "null", "-",
    ], { timeout: budgetMs, maxBuffer: 16 * 1024 * 1024 }).catch((e: any) => ({ stderr: e?.stderr ?? "" }));
    const out: number[] = [];
    for (const m of String(stderr).matchAll(/pts_time:([0-9.]+)/g)) {
      const t = Number(m[1]);
      if (Number.isFinite(t)) out.push(t);
    }
    return out;
  } catch {
    return [];
  }
}

export interface SpineCandidate { url: string; title: string; author: string }

export type BuildSpineResult =
  | { ok: true; spine: Spine; warnings: string[] }
  | { ok: false; reason: string };

/**
 * Build a spine from a ranked candidate list: pick the strongest, download it, VERIFY it, then
 * transcribe + scene-scan it into a searchable index.
 */
export async function buildSpine(candidates: SpineCandidate[], topic: string): Promise<BuildSpineResult> {
  const warnings: string[] = [];
  const ytDlp = findYtDlp();

  // 1) Choose. Official uploader + genuinely sharp + long enough to contain the whole story.
  let chosen: { c: SpineCandidate; bpp?: number; uploader?: string } | null = null;
  let relaxed = false;
  for (const pass of ["strict", "relaxed"] as const) {
    for (const c of candidates.slice(0, 12)) {
      const p = await probeCandidate(c.url, undefined, ytDlp);
      const uploader = p?.uploader ?? c.author;
      const tier = classifyUploader(uploader);
      const okTier = pass === "strict" ? tier === "official" : tier === "official" || tier === "trusted";
      const okSharp = p?.bitsPerPixel == null || p.bitsPerPixel >= SPINE_MIN_BPP;
      if (okTier && okSharp) { chosen = { c, bpp: p?.bitsPerPixel, uploader }; relaxed = pass === "relaxed"; break; }
    }
    if (chosen) break;
  }
  if (!chosen) {
    return { ok: false, reason: "No official or trusted long-form highlight met the spine bar. Fall back to per-beat clip hunting." };
  }
  if (relaxed) warnings.push(`No OFFICIAL upload qualified — using a trusted source (${chosen.uploader}). Check the footage carefully.`);

  // 2) Fetch.
  let dl;
  try {
    dl = await downloadClipToUploads(chosen.c.url);
  } catch (e) {
    return { ok: false, reason: `Spine download failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const meta = await probeFootage(dl.path);
  if (meta.duration < SPINE_MIN_DURATION_SEC) {
    return { ok: false, reason: `Spine is only ${Math.round(meta.duration)}s — too short to contain a whole story (need ${SPINE_MIN_DURATION_SEC}s+).` };
  }

  // 3) VERIFY THE SPINE. This is the single point of failure for every beat that will be cut
  //    from it, so unlike per-beat checks it is NOT allowed to fail open: an unreadable or
  //    unverifiable spine is rejected outright rather than silently trusted.
  const [v] = await verifyMoments([{
    asset: dl.path,
    start: Math.min(30, meta.duration / 4),
    end: Math.min(45, meta.duration / 2),
    expect: `real broadcast footage of: ${topic}`,
  }]);
  if (!v || v.receipt.verdict === "rejected") {
    try { fs.unlinkSync(dl.path); } catch { /* */ }
    return { ok: false, reason: `Spine rejected on inspection: ${v?.receipt.depicts || "does not look like real footage of this match"}.` };
  }
  if (v.receipt.verdict === "unverified") {
    try { fs.unlinkSync(dl.path); } catch { /* */ }
    return { ok: false, reason: "Could not visually verify the spine (no vision backend answered). Refusing to build a story on an uninspected source — retry, or fall back to per-beat hunting where each clip is checked individually." };
  }

  // 4) Index it.
  const [entries, scenes] = await Promise.all([
    transcribeSpine(dl.path, meta.duration),
    detectScenes(dl.path),
  ]);
  if (entries.length === 0) {
    warnings.push("No commentary transcript — moment search will be weak. This is usually a music-only montage.");
  }

  const spine: Spine = {
    spineId: `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    videoPath: dl.path,
    sourceUrl: chosen.c.url,
    uploader: chosen.uploader ?? "",
    durationSec: meta.duration,
    index: { entries, scenes, durationSec: meta.duration },
    createdAt: Date.now(),
  };
  spines.set(spine.spineId, spine);
  for (const [k, s] of spines) if (Date.now() - s.createdAt > SPINE_TTL_MS) spines.delete(k);

  logger.info(
    { spineId: spine.spineId, uploader: spine.uploader, durationSec: Math.round(meta.duration), entries: entries.length, scenes: scenes.length, bpp: chosen.bpp },
    "Spine built",
  );
  return { ok: true, spine, warnings };
}

export function searchSpine(spineId: string, description: string): MomentHit[] {
  const s = getSpine(spineId);
  if (!s) return [];
  return findMoment(s.index, description);
}

export interface CutRequest { description: string; start?: number; end?: number }

/**
 * Cut beats out of the spine.
 *
 * Each cut inherits a DERIVED receipt: the spine itself was visually verified, and the window
 * was located from its own transcript, so re-running a vision check per beat would be pure
 * cost. This is why stages 2 and 3 compose rather than stack — spine beats arrive pre-verified.
 */
export async function cutBeats(spineId: string, reqs: CutRequest[]): Promise<{ path?: string; start: number; end: number; verifyId?: string; snippet?: string; error?: string }[]> {
  const spine = getSpine(spineId);
  if (!spine) return reqs.map(() => ({ start: 0, end: 0, error: "Unknown or expired spineId — rebuild the spine." }));

  const out = [];
  for (const r of reqs) {
    let start = r.start, end = r.end, snippet: string | undefined;
    if (start == null || end == null) {
      const hit = findMoment(spine.index, r.description)[0];
      if (!hit) { out.push({ start: 0, end: 0, error: `Could not locate "${r.description}" in this spine — hunt for this beat separately.` }); continue; }
      start = hit.start; end = hit.end; snippet = hit.transcriptSnippet;
    }
    try {
      const seg = await extractSegment(spine.videoPath, start, end);
      const receipt = putReceipt({
        asset: seg.path, windowStart: 0, windowEnd: Math.max(1, end - start),
        verdict: "confirmed",
        depicts: snippet ?? r.description,
        onScreenText: [], flags: [], backend: "derived",
      });
      out.push({ path: seg.path, start, end, verifyId: receipt.verifyId, snippet });
    } catch (e) {
      out.push({ start, end, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
