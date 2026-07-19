import test from "node:test";
import assert from "node:assert/strict";
import { putReceipt, getReceipt, matchesReceipt, normalizeAsset, contradictsNarration, RECEIPT_TTL_MS, type Receipt } from "./receipt.ts";

const mk = (over: Partial<Receipt> = {}): Receipt => putReceipt({
  asset: "/home/u/uploads/clip_a.mp4",
  windowStart: 10, windowEnd: 20,
  verdict: "confirmed", onScreenText: [], depicts: "a goal", flags: [], backend: "gemini",
  ...over,
});

test("a matching receipt passes", () => {
  const r = mk();
  assert.deepEqual(matchesReceipt(r, { asset: "/home/u/uploads/clip_a.mp4", start: 12, end: 18 }), { ok: true });
});

test("MISSING receipt is refused with an actionable message", () => {
  const v = matchesReceipt(undefined, { asset: "x.mp4", start: 0, end: 5 });
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /verify_moment/);
});

test("receipt for a DIFFERENT clip is refused", () => {
  const r = mk();
  const v = matchesReceipt(r, { asset: "/home/u/uploads/clip_b.mp4", start: 12, end: 18 });
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /different clip/);
});

test("NON-OVERLAPPING window is refused", () => {
  // The hole this closes: verify seconds 10-20 of a highlight, then render minute 8 of it.
  const r = mk();
  const v = matchesReceipt(r, { asset: "/home/u/uploads/clip_a.mp4", start: 400, end: 410 });
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /actually render/);
});

test("PARTIAL overlap passes — a 3-frame sample is narrower than the beat", () => {
  const r = mk({ windowStart: 12, windowEnd: 14 });
  assert.deepEqual(matchesReceipt(r, { asset: "clip_a.mp4", start: 10, end: 20 }), { ok: true });
});

test("EXPIRED receipt is refused", () => {
  const r = mk();
  const v = matchesReceipt(r, { asset: "clip_a.mp4", start: 12, end: 18 }, Date.now() + RECEIPT_TTL_MS + 1000);
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /expired/);
});

test("a REJECTED verdict blocks, and cannot be argued with", () => {
  const r = mk({ verdict: "rejected", depicts: "a cat, not football" });
  const v = matchesReceipt(r, { asset: "clip_a.mp4", start: 12, end: 18 });
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /cat/);
});

test("UNVERIFIED (backend outage) still passes — fail-open on infrastructure", () => {
  // Infrastructure failure is not evidence about the footage. A Gemini outage must not brick
  // story creation; the caller is warned instead.
  const r = mk({ verdict: "unverified" });
  assert.deepEqual(matchesReceipt(r, { asset: "clip_a.mp4", start: 12, end: 18 }), { ok: true });
});

test("local files match by basename, URLs by normalised form", () => {
  assert.equal(normalizeAsset("/a/b/c/clip.mp4"), "clip.mp4");
  assert.equal(normalizeAsset("https://YouTube.com/watch?v=x#t=1"), "https://youtube.com/watch");
});

test("getReceipt round-trips and unknown ids return undefined", () => {
  const r = mk();
  assert.equal(getReceipt(r.verifyId)?.verifyId, r.verifyId);
  assert.equal(getReceipt("nope"), undefined);
});

test("⭐ the chyron case: on-screen text naming an unmentioned team contradicts", () => {
  // The real failure — "ARGENTINA 1-2 IN THE SEMIFINAL" burned into a clip used under a
  // France narration line.
  const hit = contradictsNarration(
    ["ARGENTINA 1-2 IN THE SEMIFINAL", "FIFA WORLD CUP 2026"],
    "France fell short against England, but Kylian Mbappe turned it into his history book.",
    ["Argentina", "Spain", "Brazil", "England", "France"],
  );
  assert.ok(hit, "must flag Argentina appearing on screen but not in the line");
  assert.match(hit!, /Argentina/);
});

test("chyron check does not fire when the screen agrees with the line", () => {
  assert.equal(
    contradictsNarration(["ENGLAND 6-4 FRANCE"], "England beat France six-four in the third place playoff.", ["England", "France", "Argentina"]),
    null,
  );
});
