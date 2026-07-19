import test from "node:test";
import assert from "node:assert/strict";
import { scoreOne, sharpnessScore, engagementScore, rankCandidates, WEIGHTS } from "./score.ts";
import { parseTopic, scoreRelevance } from "./relevance.ts";
import { classifyUploader } from "./sources.ts";
import { parseProbeLine, bitsPerPixel, parseUploadDate } from "./probe.ts";
import type { RawCandidate } from "./types.ts";

const cand = (o: Partial<RawCandidate>): RawCandidate => ({
  platform: "youtube", sourceUrl: "u", title: "", author: "", engagement: 0, createdAt: 0, ...o,
});

// ─── probe.ts ────────────────────────────────────────────────────────────────────────────

test("parseProbeLine: the real verified yt-dlp line", () => {
  // Captured live from yt-dlp --no-download --print on a FIFA upload.
  const r = parseProbeLine("1920|1080|30|2974.638|2876.098|FIFA|FIFA|20260704");
  assert.equal(r.width, 1920);
  assert.equal(r.height, 1080);
  assert.equal(r.fps, 30);
  assert.equal(r.uploader, "FIFA");
  // Must match the post-download ffprobe measurement of the same file (0.0462).
  assert.ok(Math.abs(r.bitsPerPixel! - 0.0462) < 0.0005, `got ${r.bitsPerPixel}`);
  assert.equal(r.bppApprox, false);
  assert.equal(r.uploadedAt, parseUploadDate("20260704"));
});

test("bitsPerPixel: fps is load-bearing — 60fps must halve the result", () => {
  // This is the whole reason fps is in the print string. Assuming 30 on a 60fps broadcast feed
  // would DOUBLE the computed bpp, letting mush through and demoting the sharpest footage.
  const at30 = bitsPerPixel(1920, 1080, 30, 2876)!.bpp!;
  const at60 = bitsPerPixel(1920, 1080, 60, 2876)!.bpp!;
  assert.ok(Math.abs(at30 / at60 - 2) < 1e-9, "60fps must be exactly half of 30fps");
});

test("bitsPerPixel: missing input NEVER guesses", () => {
  assert.equal(bitsPerPixel(1920, 1080, undefined, 2876).bpp, undefined, "must not assume fps");
  assert.equal(bitsPerPixel(1920, 1080, 30, undefined, undefined).bpp, undefined);
  assert.equal(bitsPerPixel(undefined, 1080, 30, 2876).bpp, undefined);
});

test("bitsPerPixel: falls back to tbr and flags it approximate", () => {
  const r = bitsPerPixel(1920, 1080, 30, undefined, 2974);
  assert.ok(r.bpp! > 0);
  assert.equal(r.approx, true, "tbr includes audio, so it overstates");
});

test("parseProbeLine: NA fields degrade to undefined, not zero", () => {
  const r = parseProbeLine("NA|NA|NA|NA|NA|NA|NA|NA");
  assert.equal(r.bitsPerPixel, undefined);
  assert.equal(r.uploader, undefined);
  assert.equal(r.uploadedAt, 0);
});

// ─── sources.ts ──────────────────────────────────────────────────────────────────────────

test("classifyUploader: real channel names", () => {
  assert.equal(classifyUploader("FIFA"), "official");
  assert.equal(classifyUploader("Sky Sports Football"), "official");
  assert.equal(classifyUploader("r/soccer"), "trusted");
  assert.equal(classifyUploader("Some Guy"), "neutral");
  // Recap-farm shapes measured off real low-bitrate re-uploads.
  assert.equal(classifyUploader("Football Highlights HD"), "suspect");
  assert.equal(classifyUploader("AI Sports Recaps"), "suspect");
  assert.equal(classifyUploader("SoccerZone1234"), "suspect");
});

// ─── relevance.ts ────────────────────────────────────────────────────────────────────────

test("era mismatch hard-drops, matching and absent years survive", () => {
  const spec = parseTopic("France vs England 2026 World Cup");
  assert.equal(scoreRelevance("France vs England 2022 Highlights", spec).hardDrop, true);
  assert.notEqual(scoreRelevance("France vs England 2026 Highlights", spec).hardDrop, true);
  // Absence of a year is not evidence of the wrong era.
  assert.notEqual(scoreRelevance("France vs England Highlights", spec).hardDrop, true);
});

test("content ABOUT footage is hard-dropped", () => {
  const spec = parseTopic("France vs England");
  for (const t of ["My REACTION to France vs England", "France vs England tactical breakdown", "France vs England watchalong"]) {
    assert.equal(scoreRelevance(t, spec).hardDrop, true, t);
  }
});

test("video-game contamination still hard-drops", () => {
  const spec = parseTopic("France vs England");
  assert.equal(scoreRelevance("France vs England FC 26 gameplay", spec).hardDrop, true);
});

// ─── the specification ───────────────────────────────────────────────────────────────────

test("⭐ REGRESSION: the real recap re-upload must LOSE to the real broadcast clip", () => {
  // Both candidates are real, from the shipped failure video. Under the OLD weights
  // (relevance .34 / engagement .34 / recency .12 / quality-from-duration .20) the recap won,
  // because its title matched just as well and it had far more views. This test IS the
  // requirement: measured sharpness plus uploader reputation must now outweigh view count.
  const spec = parseTopic("England vs France 6-4 World Cup 2026 third place");
  const engHigh = 1.0, engLow = 0.25;

  const recap = scoreOne(
    cand({ title: "England vs France 6-4 Highlights", author: "Football Highlights HD", engagement: 500000 }),
    spec, engHigh,
    { width: 1920, height: 1080, fps: 30, bitsPerPixel: 0.008, bppApprox: false, uploader: "Football Highlights HD", uploadedAt: 0 },
  );
  const broadcast = scoreOne(
    cand({ title: "England vs France 6-4 Highlights", author: "FIFA", engagement: 40000 }),
    spec, engLow,
    { width: 1920, height: 1080, fps: 30, bitsPerPixel: 0.044, bppApprox: false, uploader: "FIFA", uploadedAt: 0 },
  );

  assert.ok(!broadcast.drop, "broadcast footage must survive");
  assert.ok(
    broadcast.total > recap.total,
    `broadcast (${broadcast.total.toFixed(3)}) must outrank recap (${recap.total.toFixed(3)}) despite 12x fewer views`,
  );
});

test("unusably soft footage is dropped at rank time", () => {
  const spec = parseTopic("England vs France");
  const r = scoreOne(
    cand({ title: "England vs France Highlights", author: "Someone" }),
    spec, 0.5,
    { width: 640, height: 360, fps: 30, bitsPerPixel: 0.005, bppApprox: false, uploadedAt: 0 },
  );
  assert.ok(r.drop, "should drop");
});

test("UNMEASURED sharpness scores neutral and is never dropped", () => {
  // A failed probe (timeout, geo-block, platform without vbr) is not evidence of low quality.
  const spec = parseTopic("England vs France");
  const r = scoreOne(cand({ title: "England vs France Highlights", author: "Someone" }), spec, 0.5, undefined);
  assert.ok(!r.drop);
  assert.equal(r.parts.sharpness, 0.6);
});

test("engagement saturates — 10x more views is not 10x better", () => {
  assert.equal(engagementScore(0.6), 1);
  assert.equal(engagementScore(1.0), 1, "past the 60th percentile, extra reach adds nothing");
  assert.ok(engagementScore(0.1) < 0.2);
});

test("sharpness ramp matches the measured anchors", () => {
  assert.ok(sharpnessScore(0.008) < 0.05, "recap mush ~0");
  assert.ok(sharpnessScore(0.044) > 0.9, "broadcast 1080p ~1");
  assert.ok(sharpnessScore(0.032) > sharpnessScore(0.017), "native 720p beats a soft news rip");
  // Sharp but tiny is still unusable in a 1080-wide frame.
  assert.ok(sharpnessScore(0.05, 480) < sharpnessScore(0.05, 1080));
});

test("weights sum to 1 and the causal signals dominate", () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}`);
  assert.ok(
    WEIGHTS.relevance + WEIGHTS.sharpness + WEIGHTS.reputation >= 0.75,
    "signals causally tied to correctness must dominate view count",
  );
  assert.ok(WEIGHTS.engagement < 0.1, "engagement rewards recap farms — keep it small");
});

test("rankCandidates: dedupes and sorts, facebook bypasses the topic gate", () => {
  const out = rankCandidates(
    [
      cand({ title: "England vs France 6-4 Highlights", author: "FIFA", engagement: 100, sourceUrl: "a" }),
      cand({ title: "England vs France 6-4 Highlights", author: "FIFA", engagement: 100, sourceUrl: "b" }),
      cand({ platform: "facebook", title: "anything at all", sourceUrl: "c" }),
    ],
    ["england", "france"], {} as never, undefined, "England vs France 6-4",
  );
  assert.equal(out.filter((c) => c.platform === "youtube").length, 1, "near-identical hits collapse");
  assert.ok(out.some((c) => c.platform === "facebook"), "user-supplied URLs are trusted");
});
