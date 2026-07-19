import test from "node:test";
import assert from "node:assert/strict";
import { applyPronunciation } from "./pronunciation.ts";

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

test("respells the names verified to need it", () => {
  // Measured: plain "Kylian Mbappe" synthesized as "Kylie and Mbapp"; the respelling
  // "Keelian Embappay" transcribes back as "Kylian Mbappe".
  assert.notEqual(applyPronunciation("Kylian Mbappe"), "Kylian Mbappe");
  // Measured: plain "Bukayo Saka" -> "The UK Osaka"; "Bookiyo Sahka" -> "Bookyo Saka".
  assert.equal(applyPronunciation("Bukayo Saka"), "Bookiyo Sahka");
});

test("rejects the respellings measured as harmful", () => {
  // "Bukyo" synthesized as audio transcribing to "Fuck I"; "Sakka" split into "sack a".
  // Neither may ever reappear in the map.
  const out = applyPronunciation("Bukayo Saka");
  assert.ok(!/Bukyo/.test(out), "Bukyo produced profanity-sounding audio");
  assert.ok(!/Sakka/.test(out), "Sakka split one token into two spoken words");
});

test("carries NO unmeasured entries", () => {
  // Guards the rule in pronunciation.ts: a respelling Piper splits into two spoken words
  // corrupts caption alignment, so unmeasured guesses must never sit in the map.
  // "Sakka" -> "sack a" and "Lameen" -> "Lamy" were caught exactly this way.
  for (const name of ["Konate", "Barcola", "Vinicius"]) {
    assert.equal(applyPronunciation(name), name, `${name} must stay plain until measured`);
  }
});

test("matches regardless of accents", () => {
  // "Mbappé" and "Mbappe" must fold to the same entry. (Only mapped names can be asserted
  // this way — an unmapped name is returned verbatim, accent and all.)
  assert.equal(applyPronunciation("Mbappé"), applyPronunciation("Mbappe"));
  assert.equal(applyPronunciation("Kylian Mbappé"), applyPronunciation("Kylian Mbappe"));
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
    "Kylian Mbappé and Kylian Mbappe and MBAPPE, all in one line.",
  ];
  for (const line of lines) {
    assert.equal(words(applyPronunciation(line)), words(line), `word count changed for: ${line}`);
  }
});

test("leaves already-correct names untouched", () => {
  // All four measured as already correct by the synth+transcribe probe. Respelling a name
  // Piper ALREADY says right can only make it worse, so these must never enter the map.
  assert.equal(applyPronunciation("Jude Bellingham"), "Jude Bellingham");
  assert.equal(applyPronunciation("Lionel Messi"), "Lionel Messi");
  assert.equal(applyPronunciation("Antoine Griezmann"), "Antoine Griezmann");
  assert.equal(applyPronunciation("Lionel Scaloni"), "Lionel Scaloni");
});

test("fixes surnames independently where the first name resisted every candidate", () => {
  // "Ousmane"/"Lamine" stay PLAIN — every respelling either split them or was context
  // unstable — while their surnames, which DID measure better, are fixed.
  assert.equal(applyPronunciation("Ousmane Dembele"), "Ousmane Dembelay");
  assert.equal(applyPronunciation("Lamine Yamal"), "Lamine Yamaal");
});

test("fixes Tchouameni, which plain-spelled splits into two tokens", () => {
  // plain -> "T Tuomini" (2 tokens from 1); "Twahmeni" -> "Tuomini", stably one token.
  assert.equal(applyPronunciation("Tchouameni"), "Twahmeni");
  assert.equal(words(applyPronunciation("Aurelien Tchouameni")), 2);
});

test("fixes Olise, which Piper turns into a real English word", () => {
  // Measured: "Michael Olise" -> "Michael ALWAYS". A wrong-but-nonsense name is recoverable;
  // a wrong REAL word makes a grammatical sentence with the wrong meaning.
  assert.equal(applyPronunciation("Michael Olise"), "Michael Ohleezay");
});

test("preserves surrounding punctuation and unrelated text", () => {
  const out = applyPronunciation("Mbappe, 27, scored twice — and Messi answered.");
  assert.match(out, /, 27, scored twice — and Messi answered\.$/);
});

test("is a no-op on empty input", () => {
  assert.equal(applyPronunciation(""), "");
});
