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

// ── CLAIM RISK ─────────────────────────────────────────────────────────────────────────────
//
// Added 2026-07-19 after the user flagged copyright/claims as the reason to move off YouTube.
// This is a SECOND, independent axis and conflating it with reputation was a real design error:
//
//   reputation answers "is this real, sharp, correctly-dated footage?"  → official is BEST
//   claim risk answers "will this get the Short claimed or taken down?" → official is WORST
//
// Optimising reputation alone actively steers toward broadcast rips, which are exactly the
// footage most likely to be matched. Note also that claims match the FOOTAGE fingerprint on
// upload, not the platform it was downloaded from — so sourcing a broadcast clip from X rather
// than YouTube changes nothing. What actually helps is preferring genuinely ORIGINAL footage.

export type ClaimRisk = "high" | "medium" | "low";

/** Titles that advertise a broadcast rip. */
const BROADCAST_TITLE = /\b(full\s*match|extended\s*highlights?|match\s*highlights?|full\s*time\s*highlights?|all\s*goals)\b/i;
/** Signals of original, user-shot footage — the safest material. */
const FAN_SHOT_TITLE = /\b(fan\s*cam|fancam|from\s*the\s*stands?|in\s*the\s*stadium|my\s*view|pov|crowd\s*reaction|live\s*from)\b/i;

/**
 * Estimate takedown/claim exposure. `width`/`height` come from the pre-download probe when
 * available — a VERTICAL or square frame is strong evidence of phone footage, since broadcast
 * is always 16:9.
 */
export function claimRisk(uploader: string | undefined, title: string, width?: number, height?: number): ClaimRisk {
  const tier = classifyUploader(uploader);
  const t = title ?? "";
  const vertical = width != null && height != null && height >= width;

  if (vertical || FAN_SHOT_TITLE.test(t)) return "low";        // original footage
  if (tier === "official" || BROADCAST_TITLE.test(t)) return "high";  // broadcast rip
  if (tier === "suspect") return "high";                        // recap farms repost broadcast
  return "medium";
}

/**
 * Source score combining authenticity with claim exposure.
 *
 * `preferClaimSafe` (default TRUE) is the mode for a channel that publishes to YouTube: it
 * inverts the official-broadcaster preference, because that footage is the most likely to be
 * claimed. Set false to rank purely on authenticity (e.g. sourcing for private reference).
 */
export function sourceScore(tier: SourceTier, risk: ClaimRisk, preferClaimSafe = true): number {
  const authenticity = reputationScore(tier);
  if (!preferClaimSafe) return authenticity;
  const safety = risk === "low" ? 1 : risk === "medium" ? 0.6 : 0.15;
  // Weighted toward safety, but authenticity still matters — a claim-safe cat video is useless.
  return 0.6 * safety + 0.4 * authenticity;
}
