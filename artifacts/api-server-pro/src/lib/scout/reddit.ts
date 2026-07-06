// Reddit scout adapter — the reliable backbone (real API, downloadable clips, upvote ranking).
//
// Uses OAuth app-only when client id/secret are configured (higher rate limits); otherwise falls
// back to Reddit's public search JSON (works unauthenticated with a proper User-Agent, just
// lower limits). Returns only VIDEO posts; download is handled downstream by yt-dlp's reddit
// extractor via the post permalink.

import type { Platform, RawCandidate, ScoutAdapter, ScoutOptions } from "./types";
import { readScoutConfig, cookieFileFor, cookieHeaderFor } from "./config";
import { buildQueryPlan } from "./query";
import { logger } from "../logger";

const REDDIT_DOMAIN = /reddit\.com$/i;

const UA = "clip-studio-pro:matchstory2:v1 (by /u/clipstudio)";
const VIDEO_DOMAINS = /(^|\.)(v\.redd\.it|redgifs\.com|gfycat\.com|streamable\.com|youtube\.com|youtu\.be|twitter\.com|x\.com)$/i;

let cachedToken: { token: string; exp: number } | null = null;

async function appOnlyToken(): Promise<string | null> {
  const { reddit } = readScoutConfig();
  if (!reddit?.clientId || !reddit?.clientSecret) return null;
  if (cachedToken && Date.now() < cachedToken.exp) return cachedToken.token;
  try {
    const basic = Buffer.from(`${reddit.clientId}:${reddit.clientSecret}`).toString("base64");
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    cachedToken = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000 };
    return cachedToken.token;
  } catch {
    return null;
  }
}

interface RedditChild { data: Record<string, any> }

function toCandidate(d: Record<string, any>): RawCandidate | null {
  const isVideo = d.is_video === true || d.post_hint === "hosted:video" || d.post_hint === "rich:video" || VIDEO_DOMAINS.test(String(d.domain ?? ""));
  if (!isVideo) return null;
  const permalink = d.permalink ? `https://www.reddit.com${d.permalink}` : d.url;
  if (!permalink) return null;
  const rv = d.media?.reddit_video as Record<string, any> | undefined;
  const dec = (u: unknown) => (typeof u === "string" ? u.replace(/&amp;/g, "&") : undefined);
  const permaFull = `https://www.reddit.com${d.permalink}`;
  // Reddit-hosted: download the v.redd.it HLS (has audio) straight from the CDN with ffmpeg —
  // this sidesteps yt-dlp's Reddit API metadata call, which is IP-blocked on the phone.
  const hostedMedia = rv ? (dec(rv.hls_url) ?? dec(rv.dash_url) ?? dec(rv.fallback_url)) : undefined;
  const sourceUrl = rv ? permaFull : String(d.url ?? permalink);
  const downloadUrl = hostedMedia ?? String(d.url ?? permalink);
  const downloadKind: "hls" | "ytdlp" = hostedMedia ? "hls" : "ytdlp";
  const duration = rv?.duration;
  const thumb = d.preview?.images?.[0]?.source?.url ? String(d.preview.images[0].source.url).replace(/&amp;/g, "&") : (typeof d.thumbnail === "string" && d.thumbnail.startsWith("http") ? d.thumbnail : undefined);
  return {
    platform: "reddit",
    sourceUrl,
    title: String(d.title ?? "").slice(0, 300),
    author: d.subreddit ? `r/${d.subreddit}` : "reddit",
    engagement: Number(d.ups ?? d.score ?? 0),
    createdAt: Number(d.created_utc ?? 0),
    durationSec: typeof duration === "number" ? duration : undefined,
    thumbnail: thumb,
    downloadUrl,
    downloadKind,
  };
}

async function fetchListing(url: string, token: string | null, cookie?: string): Promise<RawCandidate[]> {
  const headers: Record<string, string> = { "User-Agent": UA };
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (cookie) headers.Cookie = cookie; // logged-in session → .json returns JSON, not the HTML wall
  const res = await fetch(url, { headers });
  const ctype = res.headers.get("content-type") ?? "";
  if (!res.ok || !ctype.includes("json")) {
    logger.warn({ status: res.status, ctype, url: url.slice(0, 80) }, "Reddit search returned non-JSON (auth/rate-limit?)");
    return [];
  }
  const j = (await res.json()) as { data?: { children?: RedditChild[] } };
  const out: RawCandidate[] = [];
  for (const ch of j.data?.children ?? []) {
    const c = toCandidate(ch.data);
    if (c) out.push(c);
  }
  return out;
}

export const redditAdapter: ScoutAdapter = {
  platform: "reddit" as Platform,
  isConfigured() {
    // Reddit now blocks anonymous search/download — need OAuth creds OR a logged-in cookie.
    const { reddit } = readScoutConfig();
    return !!(reddit?.clientId && reddit?.clientSecret) || !!cookieFileFor("reddit");
  },
  async search(topic: string, opts: ScoutOptions): Promise<RawCandidate[]> {
    const plan = buildQueryPlan(topic, opts.subreddits);
    const token = await appOnlyToken();
    const cookie = token ? undefined : cookieHeaderFor("reddit", REDDIT_DOMAIN);
    const base = token ? "https://oauth.reddit.com" : "https://www.reddit.com";
    // Reddit listings allow up to 100 per page. The video-only filter drops the bulk of a
    // generic search's hits (images/text), so we pull the full 100 to leave ~40 videos standing.
    const limit = Math.min(100, opts.maxPerPlatform ?? 100);
    const q = encodeURIComponent(plan.primary);

    const urls: string[] = [];
    // Subreddit-scoped searches (highest signal), across the last year and all-time so evergreen
    // clips backfill toward the ~40 target.
    for (const sub of plan.subreddits.slice(0, 5)) {
      const sr = `${base}/r/${encodeURIComponent(sub)}/search.json?q=${q}&restrict_sr=1&limit=${limit}&include_over_18=on`;
      urls.push(`${sr}&sort=top&t=year`);
      urls.push(`${sr}&sort=top&t=all`);
    }
    // Site-wide nets (year + all-time) to catch clips outside the mapped subreddits.
    urls.push(`${base}/search.json?q=${q}&sort=top&t=year&limit=${limit}&type=link`);
    urls.push(`${base}/search.json?q=${q}&sort=top&t=all&limit=${limit}&type=link`);

    const all: RawCandidate[] = [];
    const seen = new Set<string>();
    for (const url of urls) {
      try {
        const hits = await fetchListing(url, token, cookie);
        for (const h of hits) {
          if (seen.has(h.sourceUrl)) continue;
          seen.add(h.sourceUrl);
          all.push(h);
        }
      } catch (e) {
        logger.warn({ e }, "Reddit listing fetch errored");
      }
      // be polite to the public endpoint
      if (!token) await new Promise((r) => setTimeout(r, 700));
    }
    return all;
  },
};
