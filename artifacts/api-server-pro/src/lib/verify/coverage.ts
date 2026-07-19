// Coverage — every beat must have footage of what it names.
//
// WHY THIS EXISTS. v3 shipped with three beats naming Messi and no Messi anywhere on screen. I knew
// the gap before rendering, said so, and rendered anyway — substituting Mbappé footage under lines
// about Messi. There was nothing in the pipeline to stop that, only my judgement, and my judgement
// was "the rest is good enough".
//
// A missing clip is a SOURCING problem with three legitimate answers: find footage, rewrite the
// line, or drop the beat. Silently showing different footage is not among them, because the viewer
// hears one name and sees another.
//
// PURE module — no I/O, unit-tested.

/** Words that look like names but identify nothing. */
const NOT_ENTITIES = new Set([
  "the", "and", "but", "for", "with", "from", "that", "this", "then", "than", "just", "into",
  "his", "her", "him", "she", "they", "them", "who", "what", "when", "where", "why", "how",
  "world", "cup", "final", "goal", "goals", "match", "game", "half", "time", "first", "second",
  "third", "two", "three", "one", "here", "there", "now", "back", "look", "take", "takes",
  "need", "needed", "went", "set", "let", "tell", "does", "did", "is", "was", "are", "were",
  "it", "its", "at", "in", "on", "of", "to", "a", "an", "or", "so", "we", "he", "i", "my",
  "me", "us", "you", "your", "all", "ever", "even", "though", "still", "sitting", "living",
  "against", "after", "before", "about", "because", "completely", "personal", "stunning",
  "every", "many", "much", "very", "most", "more", "less", "best", "worst", "both", "each",
  "our", "their", "these", "those", "some", "any", "no", "not", "only", "also", "well",
]);

export interface BeatNeed {
  id: string | number;
  narration: string;
  /** Proper nouns this beat names — the things a viewer expects to SEE. */
  entities: string[];
}

export interface ClipFact {
  id: string | number;
  /** What a verifier said this clip actually shows. */
  depicts: string;
  /** Optional explicit entity list from the verifier. */
  entities?: string[];
}

export interface Gap {
  beat: string | number;
  missing: string[];
  reason: string;
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

/**
 * Extract the proper nouns a beat names.
 *
 * Capitalised mid-sentence words are the signal — narration is prose, so a capital that is not
 * sentence-initial is almost always a name. Deliberately conservative: a missed entity weakens the
 * gate, a false one blocks a renderable beat, and blocking good work is the worse failure.
 */
export function beatEntities(narration: string): string[] {
  const words = (narration ?? "").split(/\s+/);
  const out: string[] = [];
  words.forEach((raw, i) => {
    const w = raw.replace(/[^\p{L}\p{M}'-]/gu, "");
    if (w.length < 3) return;
    if (!/^\p{Lu}/u.test(w)) return;             // must be capitalised
    // NOTE: we deliberately do NOT skip sentence-initial words. The first draft did, reasoning
    // that a leading capital proves nothing — but narration routinely OPENS on the name that
    // matters ("Messi is sitting one goal behind him."), and that skip silently discarded the
    // exact entities this gate exists to protect. Common sentence-openers are handled by
    // NOT_ENTITIES instead, which is the check that actually distinguishes "But" from "Messi".
    if (NOT_ENTITIES.has(fold(w))) return;
    out.push(w);
  });
  return Array.from(new Set(out));
}

/** Does any verified clip actually contain this entity? */
function covered(entity: string, clips: ClipFact[]): boolean {
  const e = fold(entity);
  // Surname-only match too: narration says "Kylian Mbappe", a verifier says "Mbappe celebrating".
  const parts = e.split(/[\s-]+/).filter((p) => p.length > 3);
  return clips.some((c) => {
    const hay = fold(`${c.depicts} ${(c.entities ?? []).join(" ")}`);
    if (hay.includes(e)) return true;
    return parts.some((p) => hay.includes(p));
  });
}

/**
 * Check every beat against the verified clip pool.
 *
 * Returns gaps rather than throwing so the caller can report ALL of them at once — being told
 * "beat 4 is missing Messi", fixing it, and then being told "beat 5 is missing Messi" is a poor
 * way to learn you never had any Messi footage.
 */
export function checkCoverage(beats: BeatNeed[], clips: ClipFact[]): Gap[] {
  const gaps: Gap[] = [];
  for (const b of beats) {
    const ents = b.entities?.length ? b.entities : beatEntities(b.narration);
    const missing = ents.filter((e) => !covered(e, clips));
    if (missing.length) {
      gaps.push({
        beat: b.id,
        missing,
        reason: `no verified clip shows ${missing.map((m) => `"${m}"`).join(", ")} — source footage of it, reword the line, or drop the beat`,
      });
    }
  }
  return gaps;
}
