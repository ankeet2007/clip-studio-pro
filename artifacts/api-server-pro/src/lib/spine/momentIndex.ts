// Spine moment index — locating a described moment INSIDE a known-good source.
//
// This is the payoff of spine-first sourcing. Hunting six independent clips is an OPEN-SET
// retrieval problem: for each beat, search the whole internet and hope the result is the right
// match, the right era, the right moment and sharp. Six independent chances to be wrong, which
// is exactly what shipped (a cat meme, a wrong-match chyron, a 0.008-bpp re-upload).
//
// With one verified official highlight in hand, it becomes a CLOSED-SET localisation problem:
// find the timecode in a file we already have. Era, match identity and sharpness are then
// correct BY CONSTRUCTION, and the only remaining question — "where is Bellingham's goal?" —
// is answerable by deterministic text search over the commentary transcript.
//
// PURE module (no I/O) so the ranking and snapping rules are unit-testable.

export interface MomentEntry {
  /** Seconds from the start of the spine. */
  t: number;
  text: string;
}

export interface SpineIndex {
  entries: MomentEntry[];
  /** Scene-cut timecodes from ffmpeg, used to snap a hit to a real cut boundary. */
  scenes: number[];
  durationSec: number;
}

export interface MomentHit {
  start: number;
  end: number;
  /** 0-1. Low confidence should fall back to per-beat hunting FOR THAT BEAT ONLY. */
  confidence: number;
  transcriptSnippet: string;
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "with", "in", "on", "at", "is", "was",
  "his", "her", "its", "it", "he", "she", "they", "as", "but", "that", "this", "from", "by",
]);

/** Content words only — the words that actually identify a moment. */
export function keywords(s: string): string[] {
  return Array.from(new Set(
    (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  ));
}

/**
 * Snap a raw timestamp to the nearest scene cut at or before it.
 *
 * Commentary LAGS the action — a commentator says "GOAL!" a beat after the ball crosses the
 * line — so cutting exactly on the spoken timestamp starts the clip mid-celebration with the
 * goal already missed. Snapping back to the preceding scene cut lands on the camera change
 * that begins the passage. `maxBack` stops a distant cut dragging the clip somewhere unrelated.
 */
export function snapToScene(t: number, scenes: number[], maxBack = 6): number {
  let chosen: number | null = null;
  for (const s of scenes) {
    if (s > t) continue;                 // only snap BACKWARD
    if (t - s > maxBack) continue;       // too far to be the same passage
    if (chosen === null || s > chosen) chosen = s;   // latest qualifying cut
  }
  return chosen ?? t;
}

/**
 * Rank transcript entries against a described moment.
 *
 * Deliberately deterministic keyword overlap rather than a model call: it is instant, free,
 * explainable, and — because the spine transcript is produced by a model that gets proper
 * nouns right — "Bellingham" in the description reliably matches "Bellingham" in the text.
 * (This is why transcript quality matters so much: whisper rendering it "Killian Mbappe"
 * would silently break every search for "Mbappé".)
 */
export function findMoment(index: SpineIndex, description: string, leadIn = 2, minLen = 4): MomentHit[] {
  const want = keywords(description);
  if (want.length === 0 || index.entries.length === 0) return [];

  const scored = index.entries.map((e, i) => {
    const have = keywords(e.text);
    const hits = want.filter((w) => have.includes(w)).length;
    // Normalise by the DESCRIPTION's length, not the entry's: a long entry that happens to
    // contain every keyword is a better hit than a short one that contains a single common word.
    let confidence = hits / want.length;
    // A named entity landing exactly is worth more than several generic words.
    if (hits >= 2) confidence = Math.min(1, confidence + 0.15);
    return { i, e, confidence };
  }).filter((x) => x.confidence > 0);

  scored.sort((a, b) => b.confidence - a.confidence);

  return scored.slice(0, 5).map(({ i, e, confidence }) => {
    const rawStart = Math.max(0, e.t - leadIn);
    const start = snapToScene(rawStart, index.scenes);
    // Run to the next transcript entry, or a sensible default, and never past the file.
    const next = index.entries[i + 1]?.t ?? e.t + 10;
    const end = Math.min(index.durationSec, Math.max(start + minLen, next));
    return { start, end, confidence, transcriptSnippet: e.text };
  });
}
