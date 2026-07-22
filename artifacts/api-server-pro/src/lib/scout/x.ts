// X / Twitter scout adapter (Phase B) — best-effort.
//
// X has no free search API, so we drive `gallery-dl` (which handles X's GraphQL search + the
// login session) with the user's cookie. gallery-dl -j returns rich metadata + the direct
// video.twimg.com URL, which we download with ffmpeg (downloadHlsClip). Fragile by nature: it
// needs a valid cookie and breaks when X changes things — hence isolated behind the adapter.

import fs from "fs";
import { execFile } from "child_process";
import type { Platform, RawCandidate, ScoutAdapter, ScoutOptions } from "./types";
import { cookieFileFor } from "./config";
import { logger } from "../logger";

function findGalleryDl(): string {
  for (const p of ["/data/data/com.termux/files/usr/bin/gallery-dl", "/usr/local/bin/gallery-dl", "/usr/bin/gallery-dl"]) {
    if (fs.existsSync(p)) return p;
  }
  return "gallery-dl";
}

// gallery-dl's -j output for a VIDEO tweet carries no poster image (only profile pics), so the
// review grid would show blank tiles. Twitter's public syndication CDN returns the video's
// poster for a tweet id + a derived token (the react-tweet trick) — a tiny unauthenticated JSON
// GET. We upgrade each candidate's thumbnail from this, falling back to the author's avatar.
const SYNDICATION_URL = "https://cdn.syndication.twimg.com/tweet-result";

function syndicationToken(tweetId: string): string {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

async function fetchXPoster(tweetId: string): Promise<string | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const url = `${SYNDICATION_URL}?id=${encodeURIComponent(tweetId)}&token=${syndicationToken(tweetId)}&lang=en`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { video?: { poster?: string }; mediaDetails?: { media_url_https?: string }[] };
    return j.video?.poster ?? j.mediaDetails?.[0]?.media_url_https ?? undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// Upgrade candidates to their real video poster in small parallel batches, bounded by an overall
// deadline so a slow/blocked CDN never stalls the scout — anything unfetched keeps its avatar.
async function enrichThumbnails(cands: RawCandidate[]): Promise<void> {
  const CONCURRENCY = 8;
  const deadline = Date.now() + 15_000;
  for (let i = 0; i < cands.length && Date.now() < deadline; i += CONCURRENCY) {
    await Promise.all(cands.slice(i, i + CONCURRENCY).map(async (c) => {
      const id = c.sourceUrl.split("/status/")[1]?.split(/[/?]/)[0];
      if (!id) return;
      const poster = await fetchXPoster(id);
      if (poster) c.thumbnail = poster;
    }));
  }
}

// X's native-video search is SPARSE. A long AND-query ("argentina spain world cup final brawl
// fight") matches ZERO videos on X, while the same story as a short human-style query
// ("argentina brawl") returns 6-8. Reddit tolerates long queries; X does not — so search X the
// way a person actually types: keep only the ~3 most salient terms (drop stopwords / short words
// / bare numbers). Measured 2026-07-22: long scout query → 0 hits; every 2-3 word query → 6-8.
const X_STOP = new Set([
  "the","a","an","and","or","of","in","on","at","to","for","with","after","before","as","is","are",
  "was","were","by","from","this","that","new","latest","live","today","video","footage","clip",
  "clips","news","update","breaking","vs","amid","over","into","out",
]);
function shortenForX(topic: string): string {
  const terms = topic.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !X_STOP.has(w) && !/^\d+$/.test(w));
  // Dedup preserving order, keep the first 3 — X's sweet spot is 2-3 words.
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const w of terms) { if (!seen.has(w)) { seen.add(w); kept.push(w); } if (kept.length >= 3) break; }
  return kept.join(" ") || topic.trim();
}

export const xAdapter: ScoutAdapter = {
  platform: "x" as Platform,
  isConfigured() {
    return !!cookieFileFor("x");
  },
  async search(topic: string, opts: ScoutOptions): Promise<RawCandidate[]> {
    const cookie = cookieFileFor("x");
    if (!cookie) return [];
    const limit = Math.min(100, opts.maxPerPlatform ?? 100); // per feed; gallery-dl paginates to reach it
    const q = encodeURIComponent(`${shortenForX(topic)} filter:native_video`);
    const gdl = findGalleryDl();

    // Browse X the way a human does: check BOTH "Top" (f=top, most-engaged) AND "Latest"
    // (f=live, freshest) and merge — roughly doubles recall vs a single feed, deduped by tweet
    // id across feeds. (A person flips both tabs; the scout should too.)
    const feeds = opts.maxAgeHours ? ["live", "top"] : ["top", "live"];
    const byId = new Map<string, RawCandidate>();
    for (const feed of feeds) {
      const url = `https://x.com/search?q=${q}&f=${feed}`;
      const json = await runGalleryDl(gdl, cookie, url, limit);
      for (const c of parseXEntries(json)) {
        const id = c.sourceUrl.split("/status/")[1] ?? c.sourceUrl;
        if (!byId.has(id)) byId.set(id, c);
      }
    }
    const out = [...byId.values()];
    await enrichThumbnails(out);
    logger.info({ platform: "x", query: shortenForX(topic), feeds: feeds.length, hits: out.length, withPoster: out.filter((c) => c.thumbnail?.includes("video_thumb")).length }, "X search complete");
    return out;
  },
};

function runGalleryDl(gdl: string, cookie: string, url: string, limit: number): Promise<string> {
  return new Promise<string>((resolve) => {
    execFile(gdl, ["--cookies", cookie, "-j", "--range", `1-${limit}`, url], { timeout: 90_000, maxBuffer: 48 * 1024 * 1024 }, (_err, stdout) => {
      resolve(stdout || "[]"); // stderr carries only "media unavailable" warnings — ignore
    });
  });
}

/**
 * The OPERATOR'S OWN reposts (retweets) + video posts, as a CURATED clip pool. Workflow: when the
 * scout can't find a good clip for a story, the user hand-searches X, reposts the best clip on
 * their account, and the scout picks it from here. Reading ONE public profile (the user's own) via
 * gallery-dl is low-volume and safe — nothing like the mass/private-API harvest we refused. Pass
 * the user's own handle (from ?handle= or a stored setting).
 */
export interface RepostItem {
  kind: "video" | "image";  // VIDEO reposts = footage; IMAGE reposts = a still / article visual
  sourceUrl: string;         // x.com/i/status/<id>
  text: string;              // the tweet "message" — render as a card via scripts/render_tweet_card.py
  author: string;
  mediaUrl: string;          // video.twimg (download as clip) or pbs.twimg image
  thumbnail?: string;
  engagement: number;
  createdAt: number;
  durationSec?: number;
}

// Parse the operator's timeline into reposts of ANY usable kind — VIDEO (footage), IMAGE (still /
// article visual) — each carrying the tweet TEXT (the "message"). One item per tweet (video wins
// if a tweet has both). NOTE: gallery-dl only sees NATIVE media (video.twimg / pbs.twimg); pure
// link/article CARDS (e.g. an "X Article" or a marketwatch link preview) are NOT native media, so
// they don't appear here — grabbing those needs the private timeline API (the account-ban path).
function parseTimelineReposts(json: string): RepostItem[] {
  const safe = json.replace(/"(tweet_id|retweet_id|conversation_id|quote_id)":\s*(\d{16,})/g, '"$1":"$2"');
  let entries: unknown[] = [];
  try { entries = JSON.parse(safe); } catch { entries = []; }
  const byId = new Map<string, RepostItem>();
  for (const e of entries) {
    if (!Array.isArray(e) || e.length < 3 || e[0] !== 3) continue;
    const mediaUrl = String(e[1] ?? "");
    const isVideo = mediaUrl.includes("video.twimg.com");
    // `pbs.twimg.com/media` = a native photo; `/card_img` = an article/link-card preview image
    // (only surfaced when gallery-dl runs with cards=true — see fetchUserReposts).
    const isImage = mediaUrl.includes("pbs.twimg.com/media") || mediaUrl.includes("pbs.twimg.com/card_img");
    if (!isVideo && !isImage) continue;
    const m = (e[2] ?? {}) as Record<string, any>;
    const tweetId = String(m.tweet_id ?? m.retweet_id ?? "");
    if (!tweetId) continue;
    const item: RepostItem = {
      kind: isVideo ? "video" : "image",
      sourceUrl: `https://x.com/i/status/${tweetId}`,
      text: String(m.content ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      author: m.author?.name ? `@${m.author.name}` : "x",
      mediaUrl,
      thumbnail: (m.video && m.video.poster) || (isImage ? mediaUrl : (typeof m.author?.profile_image === "string" ? m.author.profile_image : undefined)),
      engagement: Number(m.favorite_count ?? 0) * 3 + Number(m.retweet_count ?? 0) * 5 + Math.round(Number(m.view_count ?? 0) / 20),
      createdAt: m.date ? Math.floor(Date.parse(String(m.date).replace(" ", "T") + "Z") / 1000) || 0 : 0,
      durationSec: typeof m.duration === "number" ? m.duration : undefined,
    };
    const prev = byId.get(tweetId);
    if (!prev || (prev.kind === "image" && item.kind === "video")) byId.set(tweetId, item);
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The operator's OWN reposts (video + image + text), newest first. `/with_replies` captures more
 * of the timeline than `/timeline` (which under `-j` often returns only the latest). Video reposts
 * are footage; image reposts are stills; every item carries the tweet text so it can be rendered
 * as a "message" card. Safe — reads ONE public profile (theirs).
 */
export async function fetchUserReposts(handle: string, limit = 60): Promise<RepostItem[]> {
  const cookie = cookieFileFor("x");
  const h = (handle || "").replace(/^@/, "").trim();
  if (!cookie || !h || !/^[A-Za-z0-9_]{1,15}$/.test(h)) return [];
  const gdl = findGalleryDl();
  const json = await new Promise<string>((resolve) => {
    // cards=true → also grab article / link-CARD reposts (their preview image lives in the tweet
    // card, not as native media, so they're invisible without this). This is why plain gallery-dl
    // "couldn't" see the Kimi/marketwatch reposts.
    execFile(gdl, ["--cookies", cookie, "-o", "retweets=true", "-o", "cards=true", "-j", "--range", `1-${limit}`, `https://x.com/${h}/with_replies`],
      { timeout: 90_000, maxBuffer: 48 * 1024 * 1024 }, (_err, stdout) => resolve(stdout || "[]"));
  });
  const items = parseTimelineReposts(json);
  logger.info({ platform: "x", handle: h, video: items.filter((i) => i.kind === "video").length, image: items.filter((i) => i.kind === "image").length }, "Fetched operator reposts (video+image+text)");
  return items;
}

function parseXEntries(json: string): RawCandidate[] {
  // Tweet IDs are 19-digit ints that exceed JS's safe-integer range; JSON.parse rounds them
  // and the resulting /status/<id> URL 404s. Quote those big ints so they survive as strings.
  const safe = json.replace(/"(tweet_id|retweet_id|conversation_id|quote_id)":\s*(\d{16,})/g, '"$1":"$2"');
  let entries: unknown[] = [];
  try { entries = JSON.parse(safe); } catch { entries = []; }
  const out: RawCandidate[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!Array.isArray(e) || e.length < 3 || e[0] !== 3) continue;
    const mediaUrl = String(e[1] ?? "");
    if (!mediaUrl.includes("video.twimg.com")) continue;
    const m = (e[2] ?? {}) as Record<string, any>;
    const tweetId = String(m.tweet_id ?? m.retweet_id ?? "");
    if (!tweetId || seen.has(tweetId)) continue;
    seen.add(tweetId);
    const fav = Number(m.favorite_count ?? 0);
    const rt = Number(m.retweet_count ?? 0);
    const views = Number(m.view_count ?? 0);
    const author = m.author?.name ? `@${m.author.name}` : "x";
    const avatar = typeof m.author?.profile_image === "string" ? m.author.profile_image : undefined;
    out.push({
      platform: "x",
      sourceUrl: `https://x.com/i/status/${tweetId}`,
      title: String(m.content ?? "").replace(/\s+/g, " ").slice(0, 300),
      author,
      // Blend likes/retweets/views into one raw signal; the ranker percentile-normalizes it.
      engagement: fav * 3 + rt * 5 + Math.round(views / 20),
      createdAt: m.date ? Math.floor(Date.parse(String(m.date).replace(" ", "T") + "Z") / 1000) || 0 : 0,
      durationSec: typeof m.duration === "number" ? m.duration : undefined,
      thumbnail: avatar, // baseline; upgraded to the real video poster in enrichThumbnails
      downloadUrl: mediaUrl,
      downloadKind: "hls", // direct video.twimg.com URL → ffmpeg stream-copy
    });
  }
  return out;
}
