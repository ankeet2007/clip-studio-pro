// Scout stage 1 — research / query building.
//
// Turns a raw topic ("Argentina vs Cape Verde red card") into a stronger search plan than one
// naive string: normalized terms, action keywords, and sensible subreddit targets. Kept as a
// deterministic local heuristic (no AI call) — good enough to widen recall, and every piece is
// tunable. The scorer downstream does the fine-grained relevance judgement.

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "vs", "v", "in", "on", "at", "to", "for", "with",
  "best", "top", "clip", "clips", "video", "videos", "moment", "moments", "highlight", "highlights",
]);

// Action words that make a sports clip pop — appended as optional query expansions.
const ACTION_WORDS = ["goal", "highlight", "red card", "save", "assist", "skill", "celebration", "fight", "comeback"];

// Topic keyword → likely subreddits. Falls back to broad sports subs.
const SUBREDDIT_MAP: { match: RegExp; subs: string[] }[] = [
  { match: /\b(soccer|football|fifa|messi|ronaldo|neymar|premier|la liga|ucl|world cup)\b/i, subs: ["soccer", "football", "fcbarcelona", "reddevils"] },
  { match: /\b(nba|basketball|lebron|curry|dunk)\b/i, subs: ["nba", "basketball"] },
  { match: /\b(nfl|touchdown|quarterback)\b/i, subs: ["nfl"] },
  { match: /\b(ufc|mma|knockout|octagon)\b/i, subs: ["ufc", "mma"] },
  { match: /\b(cricket|ipl|wicket|batsman)\b/i, subs: ["cricket"] },
  { match: /\b(f1|formula|grand prix|verstappen|hamilton)\b/i, subs: ["formula1"] },
];

const DEFAULT_SUBS = ["sports", "sportsclips", "publicfreakout"];

export interface QueryPlan {
  /** The cleaned primary query (entities/keywords, stopwords stripped). */
  primary: string;
  /** Extra query variants to widen recall (primary + one action word each). */
  variants: string[];
  /** Significant lowercased terms for the relevance scorer. */
  terms: string[];
  /** Subreddits to scope Reddit search to. */
  subreddits: string[];
}

export function buildQueryPlan(topic: string, subredditHints?: string[]): QueryPlan {
  const cleaned = topic.replace(/\s+/g, " ").trim();
  const rawTerms = cleaned
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  const terms = Array.from(new Set(rawTerms));

  // Primary query keeps the user's phrasing (better for exact-match search) minus filler.
  const primary = cleaned;
  // A couple of expansions so we don't miss clips titled around the action rather than the teams.
  const variants = ACTION_WORDS.slice(0, 3).map((a) => `${primary} ${a}`);

  let subreddits = (subredditHints ?? []).map((s) => s.replace(/^r\//i, "").trim()).filter(Boolean);
  if (subreddits.length === 0) {
    const matched = SUBREDDIT_MAP.find((m) => m.match.test(cleaned));
    subreddits = matched ? matched.subs : DEFAULT_SUBS;
  }

  return { primary, variants, terms, subreddits };
}
