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
  // PARTIAL fix, measured on two ASRs against a same-model control:
  //   plain "Bukayo Saka"    -> "The UK Osaka"  (both small.en and medium.en)
  //   resp. "Bookiyo Sahka"  -> "Bookyo Saka"   (small.en)  /  "Buki Osaka"  (medium.en)
  // The first name improves clearly on both — espeak was parsing "Bukayo" as the letters
  // U-K. The surname still leans "Osaka" on the sharper model, so this is better, not solved.
  // It also removes a SPLIT: the plain spelling turns 2 written tokens into 3 spoken words
  // ("The UK Osaka"), which is itself a caption-alignment hazard; the respelling stays at 2.
  bukayo: "Bookiyo",
  saka: "Sahka",
};

/**
 * MEASURED AND REJECTED — do not re-add these without a better candidate and a fresh
 * measurement. Each was synthesized and transcribed back; none beat the plain spelling,
 * and two were actively harmful:
 *
 *   saka:    "Sakka"     -> heard as "sack a"       ⚠️ ONE token became TWO spoken words.
 *   bukayo:  "Bookayo"   -> heard as "Gocayo"        (plain "Bukayo Saka" -> "The UK Osaka")
 *   bukayo:  "Bukyo"     -> heard as "Fuck I"       🚨 SEE THE WARNING BELOW.
 *   bukayo:  "Bookyeo"   -> heard as "Bookie O'"     (with saka:"Sackah" -> "Sacabod")
 *   lamine:  "Lameen"    -> heard as "Lamy"          ⚠️ "Lamy" is the old caption-desync bug.
 *   yamal:   "Yamahl"    -> heard as "Niemal"        (plain -> "Lamain Yammel")
 *   ousmane: "Oosmahn"   -> heard as "Guzman"        (plain -> "Alsmane Denbel")
 *   dembele: "Dombelay"  -> heard as "d'Amelie"      (plain -> "Denbel")
 *
 * The two ⚠️ cases matter beyond sounding wrong: captions are aligned to the narration by
 * word index, so a respelling Piper splits into two spoken words desynchronises every
 * caption after it. The word-count test below guards the TEXT we send, but it cannot see
 * Piper splitting a token in the AUDIO — so a candidate is only safe once measured.
 *
 * Tchouaméni / Konaté / Barcola / Olise / Scaloni / Oyarzabal / Griezmann were never
 * measured at all and so are deliberately absent. An unfixed name merely sounds wrong;
 * a bad respelling can corrupt the captions, which is worse.
 *
 * 🚨 NEVER ADD AN UNMEASURED RESPELLING. The candidate "Bukyo" for Bukayo synthesized as
 * audio that transcribes as "Fuck I Osaka". It looked entirely reasonable on paper. Had it
 * shipped, a published Short would have opened with what sounds like profanity over the
 * user's channel handle. Respellings steer a phoneme engine, and neighbouring letters
 * interact in ways you cannot predict by reading them — the ONLY way to know what a
 * candidate says is to synthesize it and listen to (or transcribe) the result.
 *
 * HOW TO MEASURE (the harness used for every entry above):
 *   1. Synthesize the candidate IN A SENTENCE, not bare — whisper is unreliable on ~1s clips:
 *        bash ~/myapp/scripts/generate_voiceover.sh "<line>" out.wav en_US-ryan-medium 1.0
 *   2. ffmpeg -i out.wav -ar 16000 -ac 1 out.16k.wav
 *   3. Transcribe it back (whisper small.en or better) and compare against the real name.
 *   4. Accept ONLY if it (a) transcribes closer to the true name than the plain spelling,
 *      (b) keeps the same word count, and (c) contains nothing embarrassing.
 */

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
