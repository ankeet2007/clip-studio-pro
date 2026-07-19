import test from "node:test";
import assert from "node:assert/strict";
import { applyPronunciation } from "./pronunciation.ts";

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

test("respells names Piper mispronounces", () => {
  // Measured failures: "Kylian Mbappe" -> "Kylie and Mbapp", "Bukayo Saka" -> "The UK Osaka".
  assert.notEqual(applyPronunciation("Kylian Mbappe"), "Kylian Mbappe");
  assert.notEqual(applyPronunciation("Bukayo Saka"), "Bukayo Saka");
});

test("matches regardless of accents", () => {
  // "Mbappé" and "Mbappe" must fold to the same entry.
  assert.equal(applyPronunciation("Mbappé"), applyPronunciation("Mbappe"));
  assert.equal(applyPronunciation("Dembélé"), applyPronunciation("Dembele"));
});

test("matches regardless of case", () => {
  assert.equal(applyPronunciation("kylian").toLowerCase(), applyPronunciation("Kylian").toLowerCase());
});

test("mirrors ALL-CAPS emphasis", () => {
  assert.equal(applyPronunciation("MBAPPE"), applyPronunciation("MBAPPE").toUpperCase());
});

test("PRESERVES WORD COUNT — captions align by word index", () => {
  // This is the invariant that makes the whole approach safe. A replacement that splits or
  // joins words desynchronises every caption after it (difflib aligns narration<->caption
  // by index in karaoke_captions_pro.py). Regression here = the old "Lamy and Yam" bug.
  const lines = [
    "France fell short against England, but Kylian Mbappe turned a chaotic match into his personal history book.",
    "Bukayo Saka bagged a stunning hat-trick, and Jude Bellingham sealed a six-four win.",
    "Ousmane Dembele and Lamine Yamal both scored; Lionel Messi watched on.",
    "Tchouameni, Konate, Barcola, Olise, Scaloni, Oyarzabal, Griezmann.",
  ];
  for (const line of lines) {
    assert.equal(words(applyPronunciation(line)), words(line), `word count changed for: ${line}`);
  }
});

test("leaves already-correct names untouched", () => {
  // Verified correct by the synth+transcribe probe — respelling them would only add risk.
  assert.equal(applyPronunciation("Jude Bellingham"), "Jude Bellingham");
  assert.equal(applyPronunciation("Lionel Messi"), "Lionel Messi");
});

test("preserves surrounding punctuation and unrelated text", () => {
  const out = applyPronunciation("Mbappe, 27, scored twice — and Messi answered.");
  assert.match(out, /, 27, scored twice — and Messi answered\.$/);
});

test("is a no-op on empty input", () => {
  assert.equal(applyPronunciation(""), "");
});
