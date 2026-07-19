// Scout stage 3 — the "best clip" ranker.
//
// A transparent, tunable multi-signal score. Each signal is 0-1; the final score is a weighted
// sum after HARD filters (unusable clips are dropped, not merely penalized). Every candidate
// keeps a `reasons` breakdown so the review UI can explain "why this clip".
//
// ── 2026-07-19 REWRITE ────────────────────────────────────────────────────────────────────
// The previous weights were { relevance .34, engagement .34, recency .12, quality .20 } where
// "relevance" was substring-matching on the title and "quality" was derived from DURATION.
// Nothing in the ranker measured the video. A recap re-upload therefore scored identically to
// real broadcast footage, and since it also out-engages broadcast footage by construction, the
// 0.34 engagement weight was an active SUBSIDY to the exact failure mode we were trying to
// avoid. A 1920x1080@519kbps (0.008 bpp) upload shipped as visibly soft B-roll as a result.
//
// Now: sharpness is MEASURED pre-download (probe.ts), uploader reputation is scored
// (sources.ts), relevance is structured (relevance.ts), and engagement is demoted and
// saturated. Relevance + sharpness + reputation = 0.80 of the weight, and all three are
// causally connected to "is this the right clip" — unlike view count.

import type { RawCandidate, ScoredCandidate, ScoutOptions } from "./types.ts";
import { parseTopic, scoreRelevance, type TopicSpec } from "./relevance.ts";
import { classifyUploader, reputationScore } from "./sources.ts";
import type { ProbeResult } from "./probe.ts";

export const WEIGHTS = {
  relevance: 0.30,   // structured entity match; also hard-gates
  sharpness: 0.28,   // MEASURED bits-per-pixel (was duration-derived "quality")
  reputation: 0.22,  // uploader tier (was not scored at all)
  recency: 0.12,
  engagement: 0.08,  // was 0.34 — the only signal anti-correlated with the goal
};

const RELEVANCE_FLOOR = 0.15;

/**
 * Rank-time sharpness floors, deliberately LOOSER than the render gate in footageQuality.ts
 * (720px / 0.02 bpp).
 *
 * A rank-time drop is invisible and unappealable — the caller never learns the clip existed.
 * A render-time rejection is reported and has documented override knobs. So the rank floor
 * only removes the unappealably unusable, and the gap between the two floors is covered by
 * steep demotion rather than deletion.
 */
export const RANK_MIN_SHORT_SIDE = 540;
export const RANK_MIN_BPP = 0.012;

/** Continuous ramp over measured bpp. Anchors from real measurements:
 *  0.008 recap mush · 0.017 news rip · 0.032 native 720p · 0.044 broadcast 1080p. */
export function sharpnessScore(bpp: number | undefined, shortSide?: number): number {
  if (bpp == null) return 0.6;                    // unknown ⇒ neutral, NEVER a drop
  const lo = RANK_MIN_BPP, hi = 0.045;
  let s = Math.max(0, Math.min(1, (bpp - lo) / (hi - lo)));
  // A sharp-but-tiny clip is still unusable in a 1080-wide frame.
  if (shortSide != null && shortSide < 720) s *= 0.6;
  return s;
}

/**
 * Saturating engagement. Past roughly the 60th percentile, more views say nothing further
 * about whether footage is GOOD — they say the uploader has reach. Saturating keeps the only
 * useful thing engagement tells us ("this isn't dead spam") and discards the harmful gradient
 * ("more views wins") that promoted recap farms.
 */
export function engagementScore(percentile: number): number {
  return Math.min(1, percentile / 0.6);
}

function percentiles(values: number[]): (v: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  return (v: number) => {
    if (sorted.length <= 1) return 1;
    let lo = 0;
    for (const s of sorted) if (s < v) lo++;
    return lo / (sorted.length - 1);
  };
}

/** Gentle recency decay: ~1 for today, ~0.5 at 30 days, still >0 for classics. Unknown date
 *  is neutral so it isn't unfairly buried. */
function recencyScore(createdAt: number): number {
  if (!createdAt || createdAt <= 0) return 0.5;
  const ageDays = Math.max(0, (Date.now() / 1000 - createdAt) / 86400);
  return 1 / (1 + ageDays / 30);
}

/** The pure scoring core, exported so the ranking can be unit-tested without any I/O. */
export function scoreOne(
  c: RawCandidate,
  spec: TopicSpec,
  engPct: number,
  probe?: ProbeResult,
): { total: number; parts: { relevance: number; sharpness: number; reputation: number; recency: number; engagement: number }; reasons: string[]; drop?: string } {
  const rel = scoreRelevance(c.title, spec);
  if (rel.hardDrop) return { total: 0, parts: { relevance: 0, sharpness: 0, reputation: 0, recency: 0, engagement: 0 }, reasons: [], drop: rel.reason };
  if (rel.score < RELEVANCE_FLOOR) return { total: 0, parts: { relevance: rel.score, sharpness: 0, reputation: 0, recency: 0, engagement: 0 }, reasons: [], drop: "off-topic" };

  const tier = classifyUploader(probe?.uploader ?? c.author, c.platform);
  if (tier === "deny") return { total: 0, parts: { relevance: rel.score, sharpness: 0, reputation: 0, recency: 0, engagement: 0 }, reasons: [], drop: "denylisted uploader" };

  const shortSide = probe?.width && probe?.height ? Math.min(probe.width, probe.height) : undefined;
  if (shortSide != null && shortSide < RANK_MIN_SHORT_SIDE) {
    return { total: 0, parts: { relevance: rel.score, sharpness: 0, reputation: 0, recency: 0, engagement: 0 }, reasons: [], drop: `unusably small (${probe!.width}x${probe!.height})` };
  }
  if (probe?.bitsPerPixel != null && probe.bitsPerPixel < RANK_MIN_BPP) {
    return { total: 0, parts: { relevance: rel.score, sharpness: 0, reputation: 0, recency: 0, engagement: 0 }, reasons: [], drop: `unusably soft (${probe.bitsPerPixel.toFixed(4)} bits/pixel)` };
  }

  const parts = {
    relevance: rel.score,
    sharpness: sharpnessScore(probe?.bitsPerPixel, shortSide),
    reputation: reputationScore(tier),
    recency: recencyScore(probe?.uploadedAt || c.createdAt),
    engagement: engagementScore(engPct),
  };

  const isMusicMontage = /\b(music|montage|no\s*commentary|song|hd\s*music|with\s*music)\b/i.test(c.title);
  const total = (
    WEIGHTS.relevance * parts.relevance +
    WEIGHTS.sharpness * parts.sharpness +
    WEIGHTS.reputation * parts.reputation +
    WEIGHTS.recency * parts.recency +
    WEIGHTS.engagement * parts.engagement
  ) * (isMusicMontage ? 0.7 : 1);

  const reasons = [
    `relevance ${(parts.relevance * 100) | 0}%`,
    probe?.bitsPerPixel != null
      ? `sharpness ${(parts.sharpness * 100) | 0}% (${probe.bitsPerPixel.toFixed(4)} bpp${probe.bppApprox ? " approx" : ""}${probe.width ? `, ${probe.width}x${probe.height}` : ""})`
      : "sharpness unmeasured (neutral)",
    `source ${tier}`,
    `engagement ${(parts.engagement * 100) | 0}% (${c.engagement})`,
  ];
  if (isMusicMontage) reasons.push("likely music montage — no commentary");
  return { total, parts, reasons };
}

/**
 * Score + sort candidates, dropping unusable ones. De-dups near-identical hits across
 * platforms. `probes` is optional — before the probe pass completes, candidates rank on the
 * unmeasured (neutral-sharpness) path, which is why partial results are still useful.
 */
export function rankCandidates(
  cands: RawCandidate[],
  terms: string[],
  opts: ScoutOptions,
  probes?: Map<string, ProbeResult>,
  topic?: string,
): ScoredCandidate[] {
  const engPct = percentiles(cands.map((c) => c.engagement || 0));
  const spec: TopicSpec = topic ? parseTopic(topic) : { entities: terms.map((t) => t.toLowerCase()) };
  const nowSec = Date.now() / 1000;
  const maxAgeSec = opts.maxAgeHours && opts.maxAgeHours > 0 ? opts.maxAgeHours * 3600 : 0;

  const scored: ScoredCandidate[] = [];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]!;
    const probe = probes?.get(c.sourceUrl);
    // upload_date from the probe repairs YouTube's createdAt:0 blind spot, so the freshness
    // filter finally works there too.
    const created = probe?.uploadedAt || c.createdAt;
    if (maxAgeSec && created > 0 && nowSec - created > maxAgeSec) continue;
    if (opts.minDurationSec && c.durationSec != null && c.durationSec < opts.minDurationSec) continue;
    // Facebook candidates are user-pasted URLs (trusted), so they skip the topic gate.
    if (c.platform === "facebook") {
      scored.push({ ...c, id: `${c.platform}_${i}_${Math.random().toString(36).slice(2, 8)}`, scores: { relevance: 1, engagement: 1, recency: 1, quality: 1, total: 1 }, reasons: ["user-supplied"] });
      continue;
    }
    const r = scoreOne(c, spec, engPct(c.engagement || 0), probe);
    if (r.drop) continue;
    scored.push({
      ...c,
      id: `${c.platform}_${i}_${Math.random().toString(36).slice(2, 8)}`,
      // `quality` is retained in the public shape for the existing review UI; it now carries
      // the measured sharpness rather than a duration guess.
      scores: { relevance: r.parts.relevance, engagement: r.parts.engagement, recency: r.parts.recency, quality: r.parts.sharpness, total: r.total },
      reasons: r.reasons,
      probe: probe ? { width: probe.width, height: probe.height, fps: probe.fps, bitsPerPixel: probe.bitsPerPixel, uploader: probe.uploader } : undefined,
    });
  }

  scored.sort((a, b) => b.scores.total - a.scores.total);

  const seen = new Set<string>();
  const deduped: ScoredCandidate[] = [];
  for (const c of scored) {
    const key = c.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40) + "|" + Math.round((c.durationSec ?? 0) / 3);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  return deduped;
}
