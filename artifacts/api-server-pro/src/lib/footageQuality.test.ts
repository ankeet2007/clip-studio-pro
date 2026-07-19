import test from "node:test";
import assert from "node:assert/strict";
import { judgeFootage, MIN_BEAT_SHORT_SIDE, MIN_BEAT_BITS_PER_PIXEL } from "./footageQuality.ts";

const stats = (width: number, height: number, bitsPerPixel?: number) =>
  ({ duration: 30, width, height, hasAudio: true, bitsPerPixel });

// The real beats measured off the first Mbappé render — these are the cases the gate exists for.
test("rejects the fake-HD recap re-upload that shipped soft", () => {
  // 1920x1080 but only 519 kbps. Resolution passes; detail does not. This is the clip the
  // user screenshotted as blurry.
  const v = judgeFootage(stats(1920, 1080, 0.008));
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /too soft/);
  assert.match((v as { reason: string }).reason, /bits\/pixel/);
});

test("rejects the soft news-broadcast rip", () => {
  assert.equal(judgeFootage(stats(1920, 1080, 0.017)).ok, false);
});

test("accepts a native 720p highlight reel", () => {
  assert.equal(judgeFootage(stats(1280, 720, 0.032)).ok, true);
});

test("accepts real broadcast 1080p", () => {
  assert.equal(judgeFootage(stats(1920, 1080, 0.044)).ok, true);
});

test("accepts sharp VERTICAL phone footage (short side is the metric)", () => {
  // 720x816 fan video: the SHORT side is 720, so it must pass. Gating on height alone
  // would mis-measure vertical clips.
  assert.equal(judgeFootage(stats(720, 816, 0.05)).ok, true);
});

test("rejects genuinely small footage", () => {
  const v = judgeFootage(stats(640, 360, 0.09));
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /too small/);
});

test("UNKNOWN values pass — a failed probe is not evidence of low quality", () => {
  assert.equal(judgeFootage({ duration: 30, hasAudio: true }).ok, true);
  assert.equal(judgeFootage(stats(1920, 1080, undefined)).ok, true);
});

test("floors are overridable, and 0 disables", () => {
  assert.equal(judgeFootage(stats(1920, 1080, 0.008), { minBitsPerPixel: 0 }).ok, true);
  assert.equal(judgeFootage(stats(640, 360, 0.09), { minShortSide: 0 }).ok, true);
  // Raising the bar rejects footage the default would accept.
  assert.equal(judgeFootage(stats(1280, 720, 0.032), { minShortSide: 1080 }).ok, false);
});

test("defaults sit between the measured soft and sharp clusters", () => {
  // Guards against someone loosening the floors past the evidence.
  assert.ok(MIN_BEAT_BITS_PER_PIXEL > 0.017, "must reject the 0.017 news rip");
  assert.ok(MIN_BEAT_BITS_PER_PIXEL < 0.032, "must accept the 0.032 native 720p reel");
  assert.equal(MIN_BEAT_SHORT_SIDE, 720);
});
