// Facebook scout adapter (Phase C) — most limited.
//
// Facebook has NO search/hashtag/page-listing that gallery-dl or yt-dlp can reach (all
// "Unsupported URL"), so topic search is impossible. The honest maximum: the user pastes
// specific FB video/reel/watch URLs (in the topic or the hints box) and we pull each with
// yt-dlp + the FB cookie. Metadata is thin (no likes/title without extraction), so these rank
// on the user's explicit choice rather than engagement.

import type { Platform, RawCandidate, ScoutAdapter, ScoutOptions } from "./types";
import { cookieFileFor } from "./config";
import { logger } from "../logger";

const FB_URL_RE = /https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/[^\s]+/gi;

export const facebookAdapter: ScoutAdapter = {
  platform: "facebook" as Platform,
  isConfigured() {
    return !!cookieFileFor("facebook");
  },
  async search(topic: string, opts: ScoutOptions): Promise<RawCandidate[]> {
    // Collect FB URLs from the topic + hints (there is no way to *discover* them).
    const haystack = [topic, ...(opts.subreddits ?? []), ...(opts.accounts ?? [])].join(" ");
    const urls = Array.from(new Set((haystack.match(FB_URL_RE) ?? []).map((u) => u.replace(/[),.]+$/, ""))));
    const out: RawCandidate[] = urls.slice(0, 8).map((u, i) => ({
      platform: "facebook",
      sourceUrl: u,
      title: `Facebook clip ${i + 1}`,
      author: "facebook",
      engagement: 0,
      createdAt: 0,
      downloadUrl: u,
      downloadKind: "ytdlp", // yt-dlp + FB cookie downloads a specific FB video
    }));
    if (out.length === 0) logger.info({ platform: "facebook" }, "Facebook: no pasted FB URLs (no search available)");
    return out;
  },
};
