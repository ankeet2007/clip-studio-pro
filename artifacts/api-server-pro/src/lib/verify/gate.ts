// The GATE — the one place the distinctness + coverage checks are actually ENFORCED.
//
// WHY THIS FILE EXISTS. distinctness.ts and coverage.ts were written, unit-tested, and then never
// called by anything that renders. v2/v3/v4 all shipped the exact defects those modules were built
// to catch — visible repetition and a caption naming a player the footage never showed — because
// the "gate" was library code with zero callers and the real beat→clip assignment was done by hand.
// Passing unit tests created the false impression the problem was fixed. This module wires the
// checks into the render path so a violating Match Story is REFUSED before any encode, on EVERY
// path (app route, connector, hand-built cloud bundle), the same way the footage-sharpness gate is.
//
// Split of responsibility, deliberately asymmetric:
//   • DISTINCTNESS is pure-local (ffmpeg aHash, no API key) → it can NEVER silently no-op, so it is
//     ALWAYS hard-enforced. This is the fix for the repetition the user can see.
//   • COVERAGE needs a description of what each clip shows. It is hard-enforced when those
//     descriptions are available — carried in the bundle as `depicts`, or produced by the vision
//     verifier when a key is present — and a LOUD WARNING (not a block) when neither exists, matching
//     verifier.ts's rule that an outage is not evidence about the footage.

import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "../logger";
import { checkDistinct, hashWindow, type WindowRef, type Violation } from "./distinctness";
import { beatEntities, checkCoverage, type BeatNeed, type ClipFact, type Gap } from "./coverage";
import { verifyMoments } from "./verifier";

const execFileAsync = promisify(execFile);

/** The subset of a StorySegment the gate reads. StorySegment satisfies this structurally. */
export interface GateSegment {
  startTime: string;
  endTime: string;
  localFile?: string;
  youtubeUrl?: string;
  narrationLine?: string;
  captionLine?: string;
  fillerAssets?: string[];
  punchline?: { word: string; asset: string };
  /** What a verifier said this beat's footage shows — lets coverage stay hard on a box with no key. */
  depicts?: string;
}

/** "HH:MM:SS" / "MM:SS" → seconds. Local so this module never imports clipProcessor (cycle). */
function hmsToSec(ts: string): number {
  const p = String(ts ?? "").split(":").map(Number);
  if (p.some((n) => !Number.isFinite(n))) return 0;
  if (p.length === 3) return p[0]! * 3600 + p[1]! * 60 + p[2]!;
  if (p.length === 2) return p[0]! * 60 + p[1]!;
  return p[0] || 0;
}

/** Duration of a media file in seconds (0 on failure). Used to bound filler/punchline hashing. */
async function probeDur(file: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
      { timeout: 15_000 },
    );
    const d = parseFloat(String(stdout).trim());
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch {
    return 0;
  }
}

/** Cap on how long a window we hash for an asset — a few frames across the head is enough. */
const HASH_SPAN_SEC = 6;

/**
 * Build the distinctness window set over EVERY asset the viewer sees — beat bases AND the
 * cut-engine's fillers/punchline. v4's worst repeat (t=54, reused in three pairs) was a FILLER
 * reused across beats; a gate that only looked at beat bases would have passed it. Beats whose
 * source is a not-yet-downloaded URL are skipped here and gated again on the render box, where the
 * bundle has localized every file.
 */
async function buildWindows(segs: GateSegment[], warnings: string[]): Promise<WindowRef[]> {
  const windows: WindowRef[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const id = `beat${i + 1}`;

    const base = (s.localFile ?? "").trim();
    if (base && fs.existsSync(base)) {
      const start = hmsToSec(s.startTime);
      let end = hmsToSec(s.endTime);
      if (!(end > start)) end = start + HASH_SPAN_SEC;
      const hashes = await hashWindow(base, start, end);
      if (hashes.length) windows.push({ id, source: base, start, end, hashes });
      else warnings.push(`${id}: could not sample frames from ${base} — not distinctness-checked`);
    } else if ((s.youtubeUrl ?? "").trim()) {
      warnings.push(`${id}: source not local yet — distinctness deferred to the render box`);
    }

    for (let f = 0; f < (s.fillerAssets ?? []).length; f++) {
      const fp = (s.fillerAssets ?? [])[f]!;
      if (!fp || !fs.existsSync(fp)) { warnings.push(`${id}.filler${f + 1}: missing file — not checked`); continue; }
      const dur = (await probeDur(fp)) || HASH_SPAN_SEC;
      const hashes = await hashWindow(fp, 0, Math.min(dur, HASH_SPAN_SEC));
      if (hashes.length) windows.push({ id: `${id}.filler${f + 1}`, source: fp, start: 0, end: Math.min(dur, HASH_SPAN_SEC), hashes });
    }

    if (s.punchline?.asset && fs.existsSync(s.punchline.asset)) {
      const dur = (await probeDur(s.punchline.asset)) || HASH_SPAN_SEC;
      const hashes = await hashWindow(s.punchline.asset, 0, Math.min(dur, HASH_SPAN_SEC));
      if (hashes.length) windows.push({ id: `${id}.punch`, source: s.punchline.asset, start: 0, end: Math.min(dur, HASH_SPAN_SEC), hashes });
    }
  }
  return windows;
}

/**
 * Assemble the clip-description pool coverage checks against. Prefers a `depicts` carried on the
 * segment (so a render box with no vision key still enforces coverage), falling back to running the
 * verifier on the beat's own window when a key is present. Returns [] pool when neither is available.
 */
async function buildClipFacts(segs: GateSegment[], geminiKey: string | undefined, warnings: string[]): Promise<ClipFact[]> {
  const clips: ClipFact[] = [];
  const toVerify: { idx: number; asset: string; start: number; end: number; expect: string }[] = [];
  segs.forEach((s, i) => {
    const carried = (s.depicts ?? "").trim();
    if (carried) { clips.push({ id: `beat${i + 1}`, depicts: carried }); return; }
    const asset = (s.localFile ?? "").trim();
    if (asset && fs.existsSync(asset) && geminiKey) {
      const start = hmsToSec(s.startTime);
      const end = hmsToSec(s.endTime) > start ? hmsToSec(s.endTime) : start + HASH_SPAN_SEC;
      toVerify.push({ idx: i, asset, start, end, expect: (s.captionLine ?? s.narrationLine ?? "").trim() });
    }
  });
  if (toVerify.length) {
    const outcomes = await verifyMoments(toVerify.map((v) => ({ asset: v.asset, start: v.start, end: v.end, expect: v.expect })));
    outcomes.forEach((o, k) => {
      const depicts = (o.receipt.depicts ?? "").trim();
      if (depicts) clips.push({ id: `beat${toVerify[k]!.idx + 1}`, depicts });
      else warnings.push(`beat${toVerify[k]!.idx + 1}: verifier returned no description (backend unreachable?)`);
    });
  }
  return clips;
}

export interface GateReport { distinct: Violation[]; coverage: Gap[]; warnings: string[] }

/**
 * Run both gates over a resolved Match Story plan. THROWS on any distinctness violation or (when a
 * description pool exists) any coverage gap, with a single message naming every offending item.
 * Returns a report on success so a caller can log/inspect it. Env escape hatches, for a topic that
 * genuinely has no alternative footage, are read here — never sprinkled through the caller:
 *   SKIP_SELECTION_GATES=1   skip everything
 *   SKIP_COVERAGE_GATE=1     skip only coverage (distinctness always runs)
 *   GATE_DISTINCT_THRESHOLD  override the 0.85 similarity limit
 */
export async function enforceMatchStoryGates(segs: GateSegment[], opts: { geminiKey?: string } = {}): Promise<GateReport> {
  if (process.env.SKIP_SELECTION_GATES === "1") {
    logger.warn("Selection gates SKIPPED (SKIP_SELECTION_GATES=1)");
    return { distinct: [], coverage: [], warnings: ["gates skipped via SKIP_SELECTION_GATES"] };
  }
  const warnings: string[] = [];

  const windows = await buildWindows(segs, warnings);
  const thrEnv = Number(process.env.GATE_DISTINCT_THRESHOLD);
  const distinct = checkDistinct(windows, Number.isFinite(thrEnv) && thrEnv > 0 ? thrEnv : undefined);

  let coverage: Gap[] = [];
  if (process.env.SKIP_COVERAGE_GATE === "1") {
    warnings.push("coverage gate skipped via SKIP_COVERAGE_GATE");
  } else {
    const beats: BeatNeed[] = segs
      .map((s, i) => {
        const text = (s.captionLine ?? "").trim() || (s.narrationLine ?? "").trim();
        return { id: `beat${i + 1}`, narration: text, entities: beatEntities(text) };
      })
      .filter((b) => b.entities.length > 0);
    const clips = await buildClipFacts(segs, opts.geminiKey, warnings);
    if (beats.length > 0 && clips.length === 0) {
      warnings.push("coverage NOT enforced — no clip descriptions available (pass `depicts` per beat or set GEMINI_API_KEY)");
    } else {
      coverage = checkCoverage(beats, clips);
    }
  }

  if (distinct.length || coverage.length) {
    const lines: string[] = [];
    if (distinct.length) {
      lines.push(`REPETITION — ${distinct.length} pair(s) of assets are too similar (this is what the user saw in v4):`);
      for (const v of distinct) lines.push(`  • ${v.a} ↔ ${v.b}: ${v.reason}`);
    }
    if (coverage.length) {
      lines.push(`SCRIPT MISMATCH — ${coverage.length} beat(s) name something no footage shows:`);
      for (const g of coverage) lines.push(`  • ${g.beat}: ${g.reason}`);
    }
    throw new Error(
      "Match Story REFUSED by the selection gate before rendering:\n" +
        lines.join("\n") +
        "\nUse a DISTINCT clip/filler for each flagged pair, and source footage of the named entity " +
        "(or reword/drop the beat). No clip or filler may be reused across beats.",
    );
  }

  if (warnings.length) logger.warn({ warnings, windows: windows.length }, "Selection gate PASSED (with warnings)");
  else logger.info({ windows: windows.length }, "Selection gate PASSED");
  return { distinct, coverage, warnings };
}
