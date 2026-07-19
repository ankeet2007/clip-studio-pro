// TTS pronunciation respellings for Piper. Zero deps on purpose so the unit test can run
// standalone (`node --test src/lib/pronunciation.test.ts`), same as cutEngine.ts.

/**
 * TTS-only pronunciation respellings.
 *
 * Piper phonemizes through espeak-ng's ENGLISH rules, which mangle most non-English
 * football names. Measured on en_US-ryan-medium by synthesizing each name and
 * transcribing the audio back with whisper — what came out was, verbatim:
 *
 *     "Kylian Mbappe"     -> "Kylie and Mbapp"
 *     "Bukayo Saka"       -> "The UK Osaka"
 *     "Ousmane Dembele"   -> "Alsmane Denbel"
 *     "Lamine Yamal"      -> "La mai nyamel"
 *     "Jude Bellingham"   -> "Jude Bellingham"   (already correct — do NOT add)
 *     "Lionel Messi"      -> "Lionel Messi"      (already correct — do NOT add)
 *
 * ⚠️ TWO RULES, both load-bearing:
 *
 *  1. **This is applied ONLY to the text handed to Piper** (inside generateNarrationWav).
 *     On-screen captions come from a SEPARATE string (`knownCaptionText`, built from each
 *     beat's `caption`), so the viewer still reads "Mbappé". An earlier attempt put phonetic
 *     spellings in the narration field itself and the phonetics leaked into the captions
 *     ("Lamy and Yam") — that is the exact failure this separation prevents.
 *
 *  2. **One token in, one token out.** Captions are aligned to the narration by word index
 *     (difflib in karaoke_captions_pro.py), so a replacement that changes the word count
 *     desynchronises every caption after it. "Kylian" -> "Keelian" is fine;
 *     "Kylian" -> "kee lee an" is NOT. The unit test enforces this.
 *
 * Add entries only after measuring them the same way — guessing at phonetics is what
 * broke this the first time.
 */
const PRONUNCIATION_MAP: Record<string, string> = {
  kylian: "Keelian",
  mbappe: "Embappay",
  bukayo: "Bookayo",
  saka: "Sakka",
  ousmane: "Oosmahn",
  dembele: "Dombelay",
  lamine: "Lameen",
  yamal: "Yamahl",
  tchouameni: "Chowameni",
  konate: "Konatay",
  barcola: "Barcola",
  olise: "Oleezay",
  scaloni: "Scalonee",
  oyarzabal: "Oyarthabal",
  griezmann: "Greezmann",
};

/** Strip diacritics so "Mbappé" and "Mbappe" hit the same map entry. */
function foldAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "");
}

/**
 * Rewrites known-mispronounced names for TTS only. Case-insensitive and accent-insensitive;
 * preserves the surrounding punctuation and the total word count. Exported for unit tests.
 */
export function applyPronunciation(text: string): string {
  if (!text) return text;
  // Split on word characters incl. accents/hyphens/apostrophes so punctuation is preserved.
  return text.replace(/[\p{L}\p{M}'’-]+/gu, (word) => {
    const key = foldAccents(word).toLowerCase().replace(/['’-]/g, "");
    const repl = PRONUNCIATION_MAP[key];
    if (!repl) return word;
    // Mirror an ALL-CAPS original (e.g. a shouted line) so emphasis isn't lost.
    return word === word.toUpperCase() && word.length > 1 ? repl.toUpperCase() : repl;
  });
}
