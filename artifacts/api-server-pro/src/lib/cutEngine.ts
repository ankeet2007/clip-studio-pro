// Cut Engine (Story Mode 2.0) — pure, dependency-free primitives for the "attention clock".
//
// The Story render moves the VISUAL at story speed (one beat = one clip, ~11s). A high-retention
// Short moves the visual at ATTENTION speed (~1.5s) while the audio stays at story speed. These
// primitives find the only legal cut points — WORD GAPS in the narration (cutting mid-word reads as
// broken; a cut that lands as a new word begins reads as intentional) — and the exact time of a chosen
// word (for a punchline cut, landed a hair EARLY because the eye needs lead time).
//
// Word timings come from whisper.cpp's DTW-full JSON (scripts/generate_captions_pro.sh, `-ojf`).
// parseWhisperWords() is a faithful TS port of scripts/karaoke_captions_pro.py `extract_words()`,
// INCLUDING the --vad timeline remap (raw per-token t_dtw sits on a silence-compacted timeline; left
// un-remapped the cuts drift progressively early). Keep the two in sync.

export interface Word {
  text: string;   // the whole word (sub-word tokens + trailing punctuation merged back in)
  start: number;  // onset in seconds on the REAL (VAD-expanded) timeline
}

export interface Range { minSec: number; maxSec: number; }
export interface Hold { start: number; end: number; }

// ---- word-array queries (the shared primitive) ----------------------------------------------------

/**
 * Next legal FILLER cut point: the onset of the first word that begins at least `minGapSec` after
 * `fromSec`. Word onsets are the only legal cut points (the cut lands as a new word begins = a clean
 * boundary; cutting mid-word looks broken). Returns null when no such word exists (e.g. past the last).
 */
export function nextWordGap(words: Word[], fromSec: number, minGapSec: number): number | null {
  const threshold = fromSec + Math.max(0, minGapSec);
  for (const w of words) {
    if (w.start >= threshold) return w.start;
  }
  return null;
}

/**
 * Time to land a PUNCHLINE cut for `target`: the onset of the (first) matching word MINUS `leadSec`
 * (~150ms), because the eye needs lead time — land it exactly on the word and it reads late. Matching
 * is case-insensitive and ignores surrounding punctuation. Returns null when the word isn't spoken.
 */
export function findWordTime(words: Word[], target: string, leadSec = 0.15): number | null {
  const key = normalizeWord(target);
  if (!key) return null;
  for (const w of words) {
    if (normalizeWord(w.text) === key) return Math.max(0, w.start - leadSec);
  }
  return null;
}

/**
 * Plan filler cut points across a beat: walk from `beatStart` toward `beatEnd`, each step advancing a
 * jittered interval in [density.minSec, density.maxSec] and snapping to the next word gap. A cut point
 * that falls inside a `holds` window (readable content someone is mid-read of) is suppressed — the walk
 * resumes at that hold's end. `rng` is injectable for deterministic tests (defaults to Math.random).
 * Returns cut times (word onsets) strictly inside (beatStart, beatEnd), in order.
 */
export function planFillerCuts(
  words: Word[],
  beatStart: number,
  beatEnd: number,
  density: Range,
  holds: Hold[] = [],
  rng: () => number = Math.random,
): number[] {
  const cuts: number[] = [];
  const lo = Math.max(0.05, Math.min(density.minSec, density.maxSec));
  const hi = Math.max(lo, Math.max(density.minSec, density.maxSec));
  let cursor = beatStart;
  // cursor advances past a new word onset or a hold end each iteration, so this is a safe upper bound.
  const maxIters = words.length + holds.length + 2;
  for (let guard = 0; guard <= maxIters; guard++) {
    const interval = lo + (hi - lo) * clamp01(rng());
    const cut = nextWordGap(words, cursor, interval);
    if (cut === null || cut >= beatEnd) break;
    const hold = holds.find((h) => cut >= h.start && cut < h.end);
    if (hold) { cursor = Math.max(cut, hold.end); continue; }
    cuts.push(cut);
    cursor = cut;
  }
  return cuts;
}

// ---- whisper DTW-full JSON -> Word[]  (port of karaoke_captions_pro.py extract_words) --------------

interface DtwToken { text?: string; t_dtw?: number; offsets?: { from?: number; to?: number }; }
interface DtwSegment { text?: string; tokens?: DtwToken[]; offsets?: { from?: number; to?: number }; }

/**
 * Flatten whisper.cpp DTW-full JSON into whole words with real-timeline onsets. Mirrors
 * karaoke_captions_pro.py extract_words(): skips special/[_..] tokens and non-speech segments, applies
 * the per-segment --vad remap, merges sub-word tokens/punctuation, and enforces non-decreasing onsets.
 */
export function parseWhisperWords(dtwJson: unknown): Word[] {
  const data = dtwJson as { transcription?: DtwSegment[] } | null;
  const segs = Array.isArray(data?.transcription) ? (data!.transcription as DtwSegment[]) : [];
  const words: Word[] = [];

  for (const s of segs) {
    if (!cleanText(s.text ?? "")) continue;                       // skip whole non-speech segments
    const segToks: { text: string; onset: number }[] = [];
    for (const t of s.tokens ?? []) {
      const tx = t.text ?? "";
      if (tx.startsWith("[_")) continue;                          // special tokens: [_BEG_], [_TT_94]...
      const dtw = t.t_dtw ?? -1;
      const onset = dtw != null && dtw >= 0 ? dtw / 100 : (t.offsets?.from ?? 0) / 1000;
      segToks.push({ text: tx, onset });
    }
    if (segToks.length === 0) continue;

    // --- VAD timeline fix: per-token t_dtw sits on the silence-compacted timeline; linearly remap it
    // onto the segment's true [offsets.from, offsets.to] span. Identity when nothing was compacted.
    const o0raw = s.offsets?.from, o1raw = s.offsets?.to;
    if (o0raw != null && o1raw != null) {
      const o0 = o0raw / 1000, o1 = o1raw / 1000;
      let c0 = Infinity, c1 = -Infinity;
      for (const tk of segToks) { if (tk.onset < c0) c0 = tk.onset; if (tk.onset > c1) c1 = tk.onset; }
      if (c1 > c0 && o1 > o0) {
        const scale = (o1 - o0) / (c1 - c0);
        for (const tk of segToks) tk.onset = o0 + (tk.onset - c0) * scale;
      } else {
        for (const tk of segToks) tk.onset = o0;
      }
    }

    // Merge sub-word tokens / punctuation back into whole words (a leading space starts a new word).
    for (const tk of segToks) {
      if (tk.text.startsWith(" ")) words.push({ text: tk.text.slice(1), start: tk.onset });
      else if (words.length) words[words.length - 1]!.text += tk.text;
      else words.push({ text: tk.text, start: tk.onset });
    }
  }

  // Clean each word; fold lone punctuation into the previous word.
  const cleaned: Word[] = [];
  for (const w of words) {
    let c = w.text.replace(/[()\[\]]/g, "");
    c = c.replace(/^[-–—]+\s*/, "").trim();
    if (!c) continue;
    if (/^[^\p{L}\p{N}]+$/u.test(c)) { if (cleaned.length) cleaned[cleaned.length - 1]!.text += c; continue; }
    cleaned.push({ text: c, start: w.start });
  }
  // Enforce non-decreasing onsets (DTW is usually monotonic; guard the rare slip).
  for (let i = 1; i < cleaned.length; i++) {
    if (cleaned[i]!.start < cleaned[i - 1]!.start) cleaned[i]!.start = cleaned[i - 1]!.start;
  }
  if (cleaned.length && cleaned[0]!.start < 0) cleaned[0]!.start = 0;
  return cleaned;
}

// ---- helpers --------------------------------------------------------------------------------------

function cleanText(t: string): string {
  return t.replace(/[\(\[].*?[\)\]]/g, "").replace(/^\s*-\s*/, "").trim();
}
function normalizeWord(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
