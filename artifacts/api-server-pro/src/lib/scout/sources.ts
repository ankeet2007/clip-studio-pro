// Scout — uploader reputation.
//
// `author` has existed on every candidate since day one but was only ever used for the
// on-screen credit line. It is the strongest cheap signal we are not using: the channels that
// produce upscaled, bitrate-starved recap uploads are IDENTIFIABLE BY NAME, and they are
// exactly the channels that win on engagement (which is why weighting engagement heavily was
// an implicit subsidy to the failure mode).
//
// ⚠️ This is deliberately a SOFT signal, with one exception. Curated lists go stale, and a
// name-based heuristic systematically disadvantages regional and non-English broadcasters who
// are perfectly legitimate sources. So only DENY hard-drops, and every demotion is logged with
// the raw author string so the lists get tuned from real runs instead of imagination.
//
// PURE module — no I/O, unit-tested.

export type SourceTier = "official" | "trusted" | "neutral" | "suspect" | "deny";

/** Official broadcasters, governing bodies and league channels — the gold standard. */
const OFFICIAL = [
  /^fifa\b/i, /^uefa\b/i, /\bconmebol\b/i, /\bconcacaf\b/i,
  /\bpremier\s*league\b/i, /\blaliga\b/i, /\bbundesliga\b/i, /\bserie\s*a\b/i, /\bligue\s*1\b/i,
  /\bespn\b/i, /\bsky\s*sports\b/i, /\btnt\s*sports\b/i, /\bbt\s*sport\b/i, /\bcbs\s*sports\b/i,
  /\bbein\s*sports?\b/i, /\bdazn\b/i, /\bfox\s*sports\b/i, /\bnbc\s*sports\b/i, /\bitv\s*sport\b/i,
  /\bgolazo\b/i, /\bmls\b/i, /\bchampions\s*league\b/i,
];

/** Known-good communities and reputable aggregators. Not official, but reliably real footage. */
const TRUSTED = [
  /^r\/(soccer|football|premierleague|championsleague|worldcup|fcbarcelona|reddevils|nba|cricket|formula1)$/i,
  /\bguardian\b/i, /\bbbc\s*sport\b/i, /\bthe\s*athletic\b/i,
];

/**
 * Recap-farm name shapes. Each pattern is here because it appeared on a real low-bitrate
 * re-upload, not because it sounds plausible.
 */
const SUSPECT = [
  /\bhighlights?\b.*\b(hd|tv|zone|arena|world|channel|club)\b/i,
  /\b(hd|tv|zone|arena)\b.*\bhighlights?\b/i,
  /\b(ai|a\.i\.)\b/i,
  /\brecaps?\b/i,
  /\bshorts?\b/i,
  /\ball\s*goals\b/i,
  /\d{3,}$/,                    // trailing digit runs: "FootballZone1234"
  /[\u{1F300}-\u{1FAFF}]/u,     // emoji in a channel name
];

/** Confirmed offenders. The ONLY tier that hard-drops — add only with evidence. */
const DENY: RegExp[] = [
  // (populate from logged demotions that prove out — deliberately empty rather than guessed)
];

/**
 * Classify an uploader. `author` is `r/<sub>` on Reddit, `@handle` on X, and the channel name
 * on YouTube — so the same function serves all platforms.
 */
export function classifyUploader(author: string | undefined, _platform?: string): SourceTier {
  const a = (author ?? "").trim();
  if (!a) return "neutral";
  if (DENY.some((re) => re.test(a))) return "deny";
  if (OFFICIAL.some((re) => re.test(a))) return "official";
  if (TRUSTED.some((re) => re.test(a))) return "trusted";
  if (SUSPECT.some((re) => re.test(a))) return "suspect";
  // ALL-CAPS multi-word channel names are a weak farm signal on their own.
  if (a.length > 6 && a === a.toUpperCase() && /\s/.test(a)) return "suspect";
  return "neutral";
}

/** Tier → 0-1 reputation score. Deny is scored 0 but is hard-dropped before scoring anyway. */
export function reputationScore(tier: SourceTier): number {
  switch (tier) {
    case "official": return 1;
    case "trusted": return 0.8;
    case "neutral": return 0.5;
    case "suspect": return 0.15;
    case "deny": return 0;
  }
}
