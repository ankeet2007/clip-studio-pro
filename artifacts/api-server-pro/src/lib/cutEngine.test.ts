// Unit tests for the Cut Engine primitive. Run with:  node --test src/lib/cutEngine.test.ts
// (Node v24 runs .ts natively; zero test deps.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextWordGap, findWordTime, planFillerCuts, parseWhisperWords, type Word } from "./cutEngine.ts";

const near = (a: number | null, b: number, eps = 1e-9) =>
  assert.ok(a !== null && Math.abs(a - b) < eps, `expected ~${b}, got ${a}`);

// A synthetic narration word array (onsets in seconds).
const WORDS: Word[] = [
  { text: "the", start: 0.0 },
  { text: "ocean", start: 0.4 },
  { text: "swallowed", start: 1.2 },
  { text: "the", start: 2.0 },
  { text: "whole", start: 2.3 },
  { text: "server", start: 3.1 },
  { text: "farm", start: 5.0 },
];
const STARTS = new Set(WORDS.map((w) => w.start));

// ---- nextWordGap --------------------------------------------------------------------------------
test("nextWordGap returns the first word onset >= fromSec + minGap", () => {
  near(nextWordGap(WORDS, 0, 1.0), 1.2);   // first onset >= 1.0
  near(nextWordGap(WORDS, 1.2, 1.0), 2.3); // first onset >= 2.2
});

test("nextWordGap only ever returns a real word boundary (never mid-word)", () => {
  for (let from = 0; from < 5; from += 0.13) {
    const g = nextWordGap(WORDS, from, 0.5);
    if (g !== null) assert.ok(STARTS.has(g), `${g} is not a word onset`);
  }
});

test("nextWordGap returns null when no word is far enough ahead", () => {
  assert.equal(nextWordGap(WORDS, 4.0, 2.0), null); // threshold 6.0, last word is 5.0
  assert.equal(nextWordGap([], 0, 0.1), null);
});

// ---- findWordTime -------------------------------------------------------------------------------
test("findWordTime returns the word onset minus the lead", () => {
  near(findWordTime(WORDS, "server"), 3.1 - 0.15);   // default 150ms lead
  near(findWordTime(WORDS, "server", 0), 3.1);       // no lead
});

test("findWordTime is case/punctuation insensitive", () => {
  near(findWordTime(WORDS, "Server,", 0), 3.1);
  near(findWordTime(WORDS, "  SWALLOWED!  ", 0), 1.2);
});

test("findWordTime returns null when the word isn't spoken (punchline can't fire)", () => {
  assert.equal(findWordTime(WORDS, "boredom"), null);
  assert.equal(findWordTime(WORDS, ""), null);
});

test("findWordTime never returns a negative time", () => {
  near(findWordTime([{ text: "go", start: 0.05 }], "go", 0.15), 0);
});

// ---- planFillerCuts -----------------------------------------------------------------------------
const RNG = () => 0.5; // deterministic midpoint interval

test("planFillerCuts spaces cuts by the density interval, snapped to word gaps", () => {
  const cuts = planFillerCuts(WORDS, 0, 6.0, { minSec: 1.0, maxSec: 1.0 }, [], RNG);
  assert.deepEqual(cuts, [1.2, 2.3, 5.0]);
  for (const c of cuts) assert.ok(STARTS.has(c)); // every cut is a word boundary
});

test("planFillerCuts suppresses cuts inside a readable hold, resuming after it", () => {
  const cuts = planFillerCuts(WORDS, 0, 6.0, { minSec: 1.0, maxSec: 1.0 }, [{ start: 2.0, end: 4.0 }], RNG);
  assert.deepEqual(cuts, [1.2, 5.0]); // the 2.3 cut is inside [2,4) -> dropped
});

test("planFillerCuts respects a leading readable-hold (duration floor)", () => {
  const cuts = planFillerCuts(WORDS, 0, 6.0, { minSec: 0.5, maxSec: 0.5 }, [{ start: 0, end: 2.5 }], RNG);
  assert.ok(cuts.length > 0 && cuts.every((c) => c >= 2.5), `expected all cuts >= 2.5, got ${cuts}`);
});

test("planFillerCuts honours beatEnd and degrades safely on empty input", () => {
  const cuts = planFillerCuts(WORDS, 0, 2.5, { minSec: 1.0, maxSec: 1.0 }, [], RNG);
  assert.deepEqual(cuts, [1.2, 2.3]); // 5.0 is past beatEnd
  assert.deepEqual(planFillerCuts([], 0, 10, { minSec: 1, maxSec: 2 }), []);
});

test("planFillerCuts always makes forward progress (no infinite loop) even at tiny density", () => {
  const cuts = planFillerCuts(WORDS, 0, 6.0, { minSec: 0, maxSec: 0 }, [], RNG);
  for (let i = 1; i < cuts.length; i++) assert.ok(cuts[i]! > cuts[i - 1]!);
});

// ---- parseWhisperWords (DTW-full JSON -> Word[]) -------------------------------------------------
test("parseWhisperWords flattens tokens and applies the VAD remap", () => {
  const j = {
    transcription: [
      {
        text: " hello world",
        offsets: { from: 1000, to: 2000 }, // real timeline 1.0s..2.0s
        tokens: [
          { text: " hello", t_dtw: 0 },    // compacted onset 0.00s
          { text: " world", t_dtw: 50 },   // compacted onset 0.50s
        ],
      },
    ],
  };
  const w = parseWhisperWords(j);
  assert.deepEqual(w.map((x) => x.text), ["hello", "world"]);
  near(w[0]!.start, 1.0); // remapped 0.00 -> segment start
  near(w[1]!.start, 2.0); // remapped 0.50 (max) -> segment end span
});

test("parseWhisperWords merges sub-word tokens and skips special tokens", () => {
  const j = {
    transcription: [
      {
        text: " swallowed it",
        tokens: [
          { text: "[_BEG_]", t_dtw: 0 },   // special -> skipped
          { text: " swal", t_dtw: 10 },
          { text: "lowed", t_dtw: 15 },     // sub-word -> merges into "swallowed"
          { text: " it", t_dtw: 40 },
          { text: ".", t_dtw: 45 },         // punctuation -> merges into "it"
        ],
      },
    ],
  };
  const w = parseWhisperWords(j);
  assert.deepEqual(w.map((x) => x.text), ["swallowed", "it."]);
  near(w[0]!.start, 0.10);
});

test("parseWhisperWords drops non-speech segments and tolerates junk", () => {
  const j = { transcription: [{ text: "(music)", tokens: [{ text: " (music)", t_dtw: 0 }] }] };
  assert.deepEqual(parseWhisperWords(j), []);
  assert.deepEqual(parseWhisperWords({}), []);
  assert.deepEqual(parseWhisperWords(null), []);
});
