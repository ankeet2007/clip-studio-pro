// Scout — structured relevance, replacing substring-matching on the title.
//
// The old scorer was literally `hits / terms.length` over `title.toLowerCase().includes(t)`.
// That treats every token as equally meaningful, so "England vs France 6-4 Highlights" and
// "My REACTION to England vs France" and a 2022 re-upload of the same fixture all score the
// same. Structured matching lets us weight what actually identifies a clip (both teams present
// ≫ one team) and hard-drop two whole classes of impostor.
//
// PURE module — no I/O, unit-tested.

/** Video-game / simulated-match contamination. Moved verbatim from score.ts.
 *  These get titled EXACTLY like real fixtures — especially for a match not yet played — so a
 *  naive pipeline could splice a game render in as broadcast footage. Tight enough to spare
 *  real footage: `\bfc\s*2[0-9]\b` matches the game "FC 26" but not "Juventus FC 2024". */
export const SIM_CONTAMINATION_RE =
  /\b(simulation|simulated|gameplay|game\s*play|career\s*mode|e-?football|pes\s*2[0-9]|konami|dream\s*league|score\s*prediction|match\s*prediction|prediction|predicted)\b|\bfc\s*2[0-9]\b/i;

/** Content that is ABOUT footage rather than being footage. Never usable as B-roll. */
export const NON_FOOTAGE_RE =
  /\b(reaction|reacts?\s+to|watchalong|watch\s*along|podcast|analysis|analysed|analyzed|tier\s*list|my\s+thoughts|preview|predictions?|press\s*conference|interview|fan\s*cam|tactical\s+breakdown|explained|review)\b/i;

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "vs", "v", "in", "on", "at", "to", "for", "with",
  "best", "top", "clip", "clips", "video", "videos", "moment", "moments", "highlight", "highlights",
  "goal", "goals", "full", "hd", "match", "game",
  // COMPETITION NAMES — measured bug, 2026-07-19. These were counting as identifying entities,
  // so a search for "Lionel Messi Argentina 2026 World Cup" scored ANY title containing
  // "World Cup" at 2/6 relevance — comfortably over the floor. A Messi query came back full of
  // "Top 20 Scott McTominay Goals | World Cup Reds" and Marcus Rashford posts.
  // A competition name is the LEAST identifying word in a sports search: it is shared by every
  // candidate. Only players, teams and events distinguish one clip from another.
  "world", "cup", "worldcup", "fifa", "uefa", "league", "champions", "championship", "final", "finals",
  "semifinal", "semi", "quarterfinal", "playoff", "playoffs", "tournament", "season", "round",
]);

export interface TopicSpec {
  /** Significant lowercased entity tokens (teams, players, competitions). */
  entities: string[];
  /** Explicit 4-digit year in the topic, if any. */
  era?: number;
  /** Explicit scoreline like "6-4", if any. */
  scoreline?: string;
}

export function parseTopic(topic: string): TopicSpec {
  const cleaned = (topic ?? "").replace(/\s+/g, " ").trim();
  const era = cleaned.match(/\b(19|20)\d{2}\b/)?.[0];
  const scoreline = cleaned.match(/\b\d{1,2}\s*[-–]\s*\d{1,2}\b/)?.[0]?.replace(/\s/g, "");
  const entities = Array.from(new Set(
    cleaned.toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)),
  ));
  return { entities, era: era ? Number(era) : undefined, scoreline };
}

export interface RelevanceVerdict {
  score: number;            // 0-1
  hardDrop?: boolean;
  reason?: string;
}

export function scoreRelevance(title: string, spec: TopicSpec): RelevanceVerdict {
  const t = (title ?? "");
  const hay = t.toLowerCase();

  if (SIM_CONTAMINATION_RE.test(t)) return { score: 0, hardDrop: true, reason: "video-game / simulated match" };
  if (NON_FOOTAGE_RE.test(t)) return { score: 0, hardDrop: true, reason: "commentary about footage, not footage" };

  // ERA MISMATCH — only fires when BOTH sides state a year explicitly and they disagree.
  // A repeat fixture with an identical scoreline (2022 vs 2026 France-England) is otherwise
  // indistinguishable by title, and a re-upload channel putting a current year on old footage
  // is a known, previously-observed hazard. Titles with NO year fall through to soft scoring,
  // because absence of a year is not evidence of the wrong era.
  if (spec.era) {
    const titleYear = hay.match(/\b(19|20)\d{2}\b/)?.[0];
    if (titleYear && Number(titleYear) !== spec.era) {
      return { score: 0, hardDrop: true, reason: `era mismatch — title says ${titleYear}, topic is ${spec.era}` };
    }
  }

  if (spec.entities.length === 0) return { score: 0.5 };

  const hits = spec.entities.filter((e) => hay.includes(e));
  let score = hits.length / spec.entities.length;

  // Entity COVERAGE matters more than raw count: a clip naming both teams is far more likely
  // to be the right fixture than one naming a single team, so reward near-complete coverage.
  if (hits.length >= 2 && score >= 0.6) score = Math.min(1, score + 0.15);
  // A matching explicit scoreline is a strong fixture fingerprint.
  if (spec.scoreline && hay.replace(/\s/g, "").includes(spec.scoreline)) score = Math.min(1, score + 0.2);

  return { score };
}
