import test from "node:test";
import assert from "node:assert/strict";
import { hashSimilarity, windowSimilarity, checkDistinct, DUPLICATE_THRESHOLD, type WindowRef } from "./distinctness.ts";
import { beatEntities, checkCoverage, type BeatNeed, type ClipFact } from "./coverage.ts";

const h = (bits: string) => bits.split("").map(Number);
// Deterministic pseudo-random hashes. NOT a modular pattern — an early version used
// `(i*7+seed)%3` which has period 3, so seeds 3 apart produced IDENTICAL hashes and a
// "these are different" fixture silently tested two identical inputs.
const H64 = (seed: number) => {
  let x = seed * 2654435761 >>> 0;
  return Array.from({ length: 64 }, () => { x = (x * 1664525 + 1013904223) >>> 0; return (x >>> 16) & 1; });
};
const win = (id: number, source: string, start: number, end: number, hashes: number[][]): WindowRef =>
  ({ id, source, start, end, hashes });

// ─── distinctness ────────────────────────────────────────────────────────────────────────

test("identical hashes are 100% similar", () => {
  assert.equal(hashSimilarity(h("11110000"), h("11110000")), 1);
  assert.equal(hashSimilarity(h("11110000"), h("00001111")), 0);
});

test("window similarity takes the MAX frame pair, not the mean", () => {
  // One shared shot inside two otherwise different windows is exactly the case a viewer notices,
  // and exactly the case an average would hide.
  const a = win(1, "a.mp4", 0, 10, [H64(0), H64(1)]);
  const b = win(2, "b.mp4", 0, 10, [H64(9), H64(0)]);   // second frame identical to a's first
  assert.equal(windowSimilarity(a, b), 1);
});

test("⭐ REGRESSION: the v3 assignment must be REJECTED", () => {
  // What actually shipped: three consecutive windows of one 77s clip. Measured on the render,
  // two frames 4s apart were 100% identical.
  const M = "mbappe_goal.mp4";
  const v3 = [
    win(2, M, 18, 36, [H64(0)]),
    win(4, M, 54, 72, [H64(0)]),
    win(5, M, 36, 54, [H64(0)]),
  ];
  const violations = checkDistinct(v3);
  assert.ok(violations.length >= 2, `expected multiple violations, got ${violations.length}`);
  assert.ok(violations.some((v) => /apart/.test(v.reason)), "must flag consecutive same-source windows");
});

test("same source is allowed when far apart AND visually different", () => {
  const S = "long.mp4";
  const ok = [win(1, S, 0, 10, [H64(1)]), win(2, S, 90, 100, [H64(31)])];
  assert.deepEqual(checkDistinct(ok), []);
});

test("⭐ REGRESSION: a FILLER reused across two beats is rejected (the v4 t=54 bug)", () => {
  // v4's worst repeat was one filler asset reused across beats — the cut engine's fillers are
  // separate files, so a gate that only compared beat BASES sailed past it. The gate builds a
  // WindowRef per filler too (id `beatN.fillerK`), so the same file in two beats is same-source,
  // 0s apart → rejected. Different HASHES on purpose: this must fail on FILE identity, not luck.
  const FILL = "reaction_fancam.mp4";
  const windows: WindowRef[] = [
    win("beat1", "beat1_base.mp4", 0, 8, [H64(2)]),
    win("beat1.filler1", FILL, 0, 3, [H64(7)]),
    win("beat3", "beat3_base.mp4", 0, 8, [H64(4)]),
    win("beat3.filler1", FILL, 0, 3, [H64(9)]),   // SAME file as beat1's filler
  ];
  const v = checkDistinct(windows);
  assert.ok(
    v.some((x) => x.a === "beat1.filler1" && x.b === "beat3.filler1"),
    `the reused filler pair must be flagged, got ${JSON.stringify(v)}`,
  );
});

test("different files that LOOK the same are still rejected", () => {
  // Two different downloads of the same broadcast moment — distinct files, identical footage.
  const dup = [win(1, "a.mp4", 0, 10, [H64(5)]), win(2, "b.mp4", 0, 10, [H64(5)])];
  const v = checkDistinct(dup);
  assert.equal(v.length, 1);
  assert.match(v[0]!.reason, /identical/);
});

test("threshold sits below the measured duplicate cluster", () => {
  // v3's real pairs clustered at 89-100%; genuinely distinct beats scored well under.
  assert.ok(DUPLICATE_THRESHOLD < 0.89, "must catch the 89% cluster that shipped");
  assert.ok(DUPLICATE_THRESHOLD > 0.6, "too low would reject legitimately different football footage");
});

// ─── coverage ────────────────────────────────────────────────────────────────────────────

test("beatEntities finds the names a beat promises to show", () => {
  const e = beatEntities("So for now, we are living in the Mbappe era. But here is the twist. Messi is sitting one goal behind him.");
  assert.ok(e.includes("Mbappe"), `got ${e}`);
  assert.ok(e.includes("Messi"), `got ${e}`);
});

test("beatEntities ignores sentence-initial capitals and generic words", () => {
  const e = beatEntities("The wild part is he did it in a loss. England went rogue by halftime.");
  assert.ok(!e.includes("The"), "sentence-initial capital is not a name");
  assert.ok(!e.includes("World") && !e.includes("Cup"));
  assert.ok(e.includes("England"));
});

test("⭐ REGRESSION: v3's Messi beats must be reported as gaps", () => {
  // The exact situation that shipped: three beats naming Messi, and a clip pool with none of him.
  const beats: BeatNeed[] = [
    { id: 4, narration: "But look at the efficiency. Messi needed six World Cups and thirty-three matches.", entities: [] },
    { id: 5, narration: "So for now we are living in the Mbappe era. Messi is sitting one goal behind him.", entities: [] },
    { id: 6, narration: "Two goals and Messi takes the record straight back.", entities: [] },
  ].map((b) => ({ ...b, entities: beatEntities(b.narration) }));

  const clips: ClipFact[] = [
    { id: "m", depicts: "Mbappe celebrating a goal for France" },
    { id: "s", depicts: "Saka celebrating a goal for England" },
    { id: "b", depicts: "England players celebrating against France" },
  ];

  const gaps = checkCoverage(beats, clips);
  assert.equal(gaps.length, 3, "all three Messi beats must be flagged");
  assert.ok(gaps.every((g) => g.missing.includes("Messi")));
  assert.match(gaps[0]!.reason, /reword the line, or drop the beat/);
});

test("coverage passes once the footage exists", () => {
  const beats: BeatNeed[] = [{ id: 4, narration: "And then Messi answered.", entities: ["Messi"] }];
  const clips: ClipFact[] = [{ id: "x", depicts: "Lionel Messi scores his 21st World Cup goal" }];
  assert.deepEqual(checkCoverage(beats, clips), []);
});

test("surname-only verifier output still counts as coverage", () => {
  // Narration says "Kylian Mbappe"; the verifier said "Mbappe celebrating". Same person.
  const beats: BeatNeed[] = [{ id: 2, narration: "Then Kylian Mbappe turned it around.", entities: ["Kylian", "Mbappe"] }];
  const clips: ClipFact[] = [{ id: "m", depicts: "Mbappe celebrating a goal" }];
  const gaps = checkCoverage(beats, clips);
  assert.ok(!gaps.some((g) => g.missing.includes("Mbappe")), "surname match must count");
});

test("⭐ REGRESSION: a caption naming a player the footage never shows is a gap (the v4 t=26 bug)", () => {
  // v4 played a filler of Mbappe on the bench under a caption that said "Bukayo" — the caption named
  // a player no clip in the pool depicted. The coverage gate must flag exactly that.
  const beats: BeatNeed[] = [
    { id: "beat3", narration: "Bukayo Saka answered straight back for England.", entities: [] },
  ].map((b) => ({ ...b, entities: beatEntities(b.narration) }));
  const clips: ClipFact[] = [
    { id: "beat1", depicts: "Mbappe scoring for France" },
    { id: "beat2", depicts: "Mbappe on the bench watching" },
    { id: "beat3", depicts: "Mbappe celebrating with teammates" },
  ];
  const gaps = checkCoverage(beats, clips);
  assert.equal(gaps.length, 1, `the Bukayo/Saka beat must be flagged, got ${JSON.stringify(gaps)}`);
  assert.ok(
    gaps[0]!.missing.includes("Bukayo") || gaps[0]!.missing.includes("Saka"),
    `must name the missing player, got ${gaps[0]!.missing}`,
  );
});
