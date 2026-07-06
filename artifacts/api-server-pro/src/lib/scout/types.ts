// Match Story 2.0 "clip-scout" — shared types.
//
// The scout searches the user's platforms for a topic, ranks candidate video clips with a
// transparent multi-signal scorer, downloads the best ones, and hands the kept clips to the
// existing Match Story per-beat render as LOCAL-file beats. Job state lives in memory (see
// ./index.ts); the downloaded files persist on disk, and only the final Match Story clip row
// is stored in the DB — so no migration is needed.

export type Platform = "reddit" | "x" | "instagram" | "facebook";

/** A search hit before scoring — the metadata each adapter can cheaply return. */
export interface RawCandidate {
  platform: Platform;
  sourceUrl: string;        // permalink / post URL that yt-dlp can download
  title: string;            // caption / post title (relevance + Gemini context)
  author: string;           // subreddit / handle — used for the on-screen "Credit:" line
  engagement: number;       // raw platform metric (upvotes / likes / views)
  createdAt: number;        // unix seconds (recency)
  durationSec?: number;     // if the platform exposes it pre-download
  thumbnail?: string;       // remote thumb url (review UI)
  // Direct media URL when the search already exposes one (e.g. Reddit's v.redd.it HLS from the
  // CDN — used to bypass yt-dlp's IP-blocked Reddit API). "hls" → ffmpeg; "ytdlp" → yt-dlp on sourceUrl.
  downloadUrl?: string;
  downloadKind?: "hls" | "ytdlp";
}

export interface CandidateScores {
  relevance: number;        // 0-1, topic/entity match (hard-filtered below a floor)
  engagement: number;       // 0-1, percentile-normalized within this result set
  recency: number;          // 0-1, gentle decay
  quality: number;          // 0-1, resolution/duration/audio (post-download refines this)
  total: number;            // weighted sum
}

export interface ScoredCandidate extends RawCandidate {
  id: string;
  scores: CandidateScores;
  reasons: string[];        // human-readable "why this clip" for the review UI
}

/** A candidate after it has been downloaded + probed. */
export interface DownloadedCandidate extends ScoredCandidate {
  localFile: string;        // absolute path in the uploads dir
  durationSec: number;
  width?: number;
  height?: number;
  transcript?: string;      // optional whisper enrichment
  thumbFile?: string;       // local extracted thumbnail
  status: "candidate" | "keep" | "drop";
}

export interface ScoutOptions {
  platforms: Platform[];
  subreddits?: string[];    // Reddit target hints (else auto)
  accounts?: string[];      // X/IG/FB target hints (later phases)
  maxPerPlatform?: number;  // search-result cap per platform
  maxDownload?: number;     // how many top-ranked candidates to actually download
  minDurationSec?: number;  // target clip window
  maxDurationSec?: number;
}

export interface ScoutJob {
  id: string;
  topic: string;
  options: ScoutOptions;
  status: "searching" | "downloading" | "ready" | "error";
  progress: number;         // 0-100
  message?: string;
  candidates: DownloadedCandidate[];
  createdAt: number;
}

/** Every platform is a pluggable adapter so they degrade independently. */
export interface ScoutAdapter {
  platform: Platform;
  /** True when this adapter has whatever creds/cookies it needs to run. */
  isConfigured(): boolean;
  /** Search the platform for the topic and return raw candidates (video posts only). */
  search(topic: string, opts: ScoutOptions): Promise<RawCandidate[]>;
}
