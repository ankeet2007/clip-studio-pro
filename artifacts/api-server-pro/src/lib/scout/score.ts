// Scout stage 3 — the "best clip" ranker.
//
// A transparent, tunable multi-signal score. Each signal is 0-1; the final score is a weighted
// sum after HARD filters (irrelevant / broken clips are dropped, not merely penalized). Every
// candidate keeps a `reasons` breakdown so the review UI can explain "why this clip".

import type { RawCandidate, ScoredCandidate, ScoutOptions } from "./types";

// Weights — engagement-led, but relevance gates everything. Tunable in one place.
export const WEIGHTS = { relevance: 0.34, engagement: 0.34, recency: 0.12, quality: 0.20 };
const RELEVANCE_FLOOR = 0.15; // below this we assume it's off-topic and drop it

/** Fraction of topic terms that appear in the candidate's title (simple, fast, upgradeable). */
function relevanceScore(title: string, terms: string[]): number {
  if (terms.length === 0) return 0.5;
  const hay = title.toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return hits / terms.length;
}

/** Percentile of this candidate's engagement WITHIN the result set (cross-platform-fair). */
function percentiles(values: number[]): (v: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  return (v: number) => {
    if (sorted.length <= 1) return 1;
    let lo = 0;
    for (const s of sorted) if (s < v) lo++;
    return lo / (sorted.length - 1);
  };
}

/** Gentle recency decay: ~1 for today, ~0.5 at 30 days, still >0 for classics. */
function recencyScore(createdAt: number): number {
  const ageDays = Math.max(0, (Date.now() / 1000 - createdAt) / 86400);
  return 1 / (1 + ageDays / 30);
}

/** Pre-download quality guess from duration only (refined post-download in the service). */
function prelimQuality(durationSec: number | undefined, opts: ScoutOptions): number {
  const min = opts.minDurationSec ?? 4;
  const max = opts.maxDurationSec ?? 40;
  if (durationSec == null) return 0.6; // unknown yet — neutral-ish
  if (durationSec < min || durationSec > max) return 0.2;
  return 1;
}

/**
 * Score + sort candidates, dropping off-topic ones. De-dups near-identical hits (same
 * normalized title + similar duration) across platforms, keeping the highest score.
 */
export function rankCandidates(cands: RawCandidate[], terms: string[], opts: ScoutOptions): ScoredCandidate[] {
  const engPct = percentiles(cands.map((c) => c.engagement || 0));

  const scored: ScoredCandidate[] = [];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]!;
    // Facebook has no search — its candidates are URLs the user explicitly pasted, so they're
    // relevant by definition and skip the topic-relevance floor.
    const relevance = c.platform === "facebook" ? 1 : relevanceScore(c.title, terms);
    if (relevance < RELEVANCE_FLOOR) continue; // hard filter
    const engagement = engPct(c.engagement || 0);
    const recency = recencyScore(c.createdAt);
    const quality = prelimQuality(c.durationSec, opts);
    const total =
      WEIGHTS.relevance * relevance +
      WEIGHTS.engagement * engagement +
      WEIGHTS.recency * recency +
      WEIGHTS.quality * quality;
    const reasons: string[] = [
      `relevance ${(relevance * 100) | 0}%`,
      `engagement ${(engagement * 100) | 0}% (${c.engagement})`,
      `recency ${(recency * 100) | 0}%`,
    ];
    scored.push({ ...c, id: `${c.platform}_${i}_${Math.random().toString(36).slice(2, 8)}`, scores: { relevance, engagement, recency, quality, total }, reasons });
  }

  scored.sort((a, b) => b.scores.total - a.scores.total);

  // De-dup: the same viral clip shows up on several platforms / reposts. Collapse by a
  // normalized-title key + a coarse duration bucket, keeping the top-scored copy.
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
