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

export const xAdapter: ScoutAdapter = {
  platform: "x" as Platform,
  isConfigured() {
    return !!cookieFileFor("x");
  },
  async search(topic: string, opts: ScoutOptions): Promise<RawCandidate[]> {
    const cookie = cookieFileFor("x");
    if (!cookie) return [];
    const limit = Math.min(100, opts.maxPerPlatform ?? 100);
    const q = encodeURIComponent(`${topic} filter:native_video`);
    const url = `https://x.com/search?q=${q}&f=top`;
    const gdl = findGalleryDl();

    const json = await new Promise<string>((resolve) => {
      execFile(gdl, ["--cookies", cookie, "-j", "--range", `1-${limit}`, url], { timeout: 90_000, maxBuffer: 32 * 1024 * 1024 }, (_err, stdout) => {
        resolve(stdout || "[]"); // stderr carries only "media unavailable" warnings — ignore
      });
    });

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
        thumbnail: avatar, // baseline; upgraded to the real video poster below
        downloadUrl: mediaUrl,
        downloadKind: "hls", // direct video.twimg.com URL → ffmpeg stream-copy
      });
    }
    await enrichThumbnails(out);
    logger.info({ platform: "x", hits: out.length, withPoster: out.filter((c) => c.thumbnail?.includes("video_thumb")).length }, "X search complete");
    return out;
  },
};
