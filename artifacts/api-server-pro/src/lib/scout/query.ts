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
  // Generic football → GENERAL subs only. Club subs are added separately, and ONLY when that
  // club is actually named — see CLUB_SUBS below.
  //
  // Measured bug, 2026-07-19: this line used to append "fcbarcelona" and "reddevils" to ANY
  // football query, so a search for "Lionel Messi Argentina World Cup" was routed into
  // Manchester United's subreddit and came back full of Marcus Rashford and Ronaldo posts.
  // A player's name must not drag in an unrelated club's community.
  { match: /\b(soccer|football|fifa|messi|ronaldo|neymar|mbappe|mbappé|premier|la liga|ucl|world cup|euros?)\b/i,
    subs: ["soccer", "football", "worldcup", "sports"] },
  { match: /\b(nba|basketball|lebron|curry|dunk)\b/i, subs: ["nba", "basketball"] },
  { match: /\b(nfl|touchdown|quarterback)\b/i, subs: ["nfl"] },
  { match: /\b(ufc|mma|knockout|octagon)\b/i, subs: ["ufc", "mma"] },
  { match: /\b(cricket|ipl|wicket|batsman)\b/i, subs: ["cricket"] },
  { match: /\b(f1|formula|grand prix|verstappen|hamilton)\b/i, subs: ["formula1"] },
];

/** Club-specific subs, added ONLY when the club is named in the topic. */
const CLUB_SUBS: { match: RegExp; subs: string[] }[] = [
  { match: /\b(barcelona|barca|barça)\b/i, subs: ["fcbarcelona"] },
  { match: /\b(man\s*utd|manchester united|united)\b/i, subs: ["reddevils"] },
  { match: /\b(real madrid|madrid)\b/i, subs: ["realmadrid"] },
  { match: /\b(liverpool)\b/i, subs: ["liverpoolfc"] },
  { match: /\b(arsenal)\b/i, subs: ["gunners"] },
  { match: /\b(chelsea)\b/i, subs: ["chelseafc"] },
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
  // Query EXPANSION. Recall is the binding constraint: a single query string against one
  // platform returns a few dozen hits at best, and the hard filters downstream then remove most
  // of them. Several differently-shaped queries find genuinely different clips.
  //
  // Measured 2026-07-19: these variants existed but NO adapter ever read them — every platform
  // fired `primary` alone. Fixing that is the single largest recall lever in the pipeline.
  const ents = terms.slice(0, 4);
  const variants = Array.from(new Set([
    // Entities alone — drops narrative words the poster would never use in a caption.
    ents.length >= 2 ? ents.join(" ") : "",
    // The action framings a clip is actually titled with.
    `${ents.slice(0, 3).join(" ")} goal`,
    `${ents.slice(0, 3).join(" ")} celebration`,
    // Just the headline entity, to catch tightly-cropped single-subject clips.
    ents[0] ?? "",
  ].filter((v) => v && v !== primary)));

  let subreddits = (subredditHints ?? []).map((s) => s.replace(/^r\//i, "").trim()).filter(Boolean);
  if (subreddits.length === 0) {
    const matched = SUBREDDIT_MAP.find((m) => m.match.test(cleaned));
    subreddits = matched ? [...matched.subs] : [...DEFAULT_SUBS];
    // Append a club sub only when the topic actually names that club.
    for (const c of CLUB_SUBS) if (c.match.test(cleaned)) subreddits.push(...c.subs);
  }

  return { primary, variants, terms, subreddits };
}
