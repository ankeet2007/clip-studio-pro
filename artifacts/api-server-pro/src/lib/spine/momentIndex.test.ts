import test from "node:test";
import assert from "node:assert/strict";
import { findMoment, snapToScene, keywords, type SpineIndex } from "./momentIndex.ts";

// A realistic index built from the shape Gemini returns for a real highlight reel.
const INDEX: SpineIndex = {
  durationSec: 300,
  scenes: [0, 12, 40, 88, 120, 155, 200, 244, 280],
  entries: [
    { t: 15, text: "Declan Rice opens the scoring for England in the third minute." },
    { t: 45, text: "Ezri Konsa doubles the lead with a header." },
    { t: 92, text: "Bukayo Saka makes it three, a stunning strike into the far corner." },
    { t: 125, text: "Kylian Mbappe pulls one back for France just after the interval." },
    { t: 160, text: "Bradley Barcola with the second for France." },
    { t: 205, text: "Saka completes his hat-trick from the penalty spot." },
    { t: 248, text: "Jude Bellingham seals it in stoppage time for England." },
  ],
};

test("finds the moment by name", () => {
  const hits = findMoment(INDEX, "Jude Bellingham seals the win in stoppage time");
  assert.ok(hits.length > 0);
  assert.match(hits[0]!.transcriptSnippet, /Bellingham/);
});

test("distinguishes two moments involving the SAME player", () => {
  // Saka appears twice — the hat-trick line must beat the first goal line.
  const hits = findMoment(INDEX, "Saka completes his hat-trick from the penalty spot");
  assert.match(hits[0]!.transcriptSnippet, /hat-trick/);
});

test("snaps the cut back to the preceding scene boundary", () => {
  // Commentary LAGS the action, so cutting on the spoken timestamp starts mid-celebration.
  const hits = findMoment(INDEX, "Bukayo Saka stunning strike into the far corner");
  // entry t=92, leadIn 2 -> 90, nearest earlier scene cut within 6s is 88.
  assert.equal(hits[0]!.start, 88);
});

test("snapToScene only ever moves BACKWARD and never too far", () => {
  assert.equal(snapToScene(90, [88, 120]), 88);
  assert.equal(snapToScene(90, [120]), 90, "must not snap forward");
  assert.equal(snapToScene(90, [50]), 90, "40s back is a different passage — leave it");
  assert.equal(snapToScene(90, []), 90);
  assert.equal(snapToScene(90, [85, 88]), 88, "picks the LATEST qualifying cut");
});

test("a hit never runs past the end of the spine", () => {
  const short: SpineIndex = { durationSec: 20, scenes: [], entries: [{ t: 18, text: "Bellingham scores" }] };
  const hits = findMoment(short, "Bellingham scores");
  assert.ok(hits[0]!.end <= 20);
});

test("confidence is low for an unrelated description — caller falls back to hunting", () => {
  const hits = findMoment(INDEX, "Lionel Messi free kick for Argentina");
  // Either no hit at all, or a weak one; both mean "do not trust this".
  assert.ok(hits.length === 0 || hits[0]!.confidence < 0.5, `got ${hits[0]?.confidence}`);
});

test("empty description or empty index yields nothing", () => {
  assert.deepEqual(findMoment(INDEX, ""), []);
  assert.deepEqual(findMoment({ durationSec: 10, scenes: [], entries: [] }, "anything"), []);
});

test("keywords strips stopwords and short tokens", () => {
  const k = keywords("The goal was scored by Bellingham in the box");
  assert.ok(k.includes("bellingham"));
  assert.ok(!k.includes("the") && !k.includes("was") && !k.includes("by"));
});

test("⭐ proper-noun fidelity is what makes this work", () => {
  // If the transcript said "Killian Mbappe" (what whisper produced on this exact audio) a
  // search for "Mbappe" would still hit, but "Kylian" would not. This is why the spine index
  // is built with a transcriber that gets proper nouns right.
  const good = findMoment(INDEX, "Kylian Mbappe pulls one back for France");
  assert.ok(good.length > 0 && good[0]!.confidence > 0.5, "correct spelling must match strongly");
});
