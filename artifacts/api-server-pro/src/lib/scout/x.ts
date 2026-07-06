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

export const xAdapter: ScoutAdapter = {
  platform: "x" as Platform,
  isConfigured() {
    return !!cookieFileFor("x");
  },
  async search(topic: string, opts: ScoutOptions): Promise<RawCandidate[]> {
    const cookie = cookieFileFor("x");
    if (!cookie) return [];
    const limit = Math.min(50, opts.maxPerPlatform ?? 40);
    const q = encodeURIComponent(`${topic} filter:native_video`);
    const url = `https://x.com/search?q=${q}&f=top`;
    const gdl = findGalleryDl();

    const json = await new Promise<string>((resolve) => {
      execFile(gdl, ["--cookies", cookie, "-j", "--range", `1-${limit}`, url], { timeout: 90_000, maxBuffer: 32 * 1024 * 1024 }, (_err, stdout) => {
        resolve(stdout || "[]"); // stderr carries only "media unavailable" warnings — ignore
      });
    });

    let entries: unknown[] = [];
    try { entries = JSON.parse(json); } catch { entries = []; }

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
      out.push({
        platform: "x",
        sourceUrl: `https://x.com/i/status/${tweetId}`,
        title: String(m.content ?? "").replace(/\s+/g, " ").slice(0, 300),
        author,
        // Blend likes/retweets/views into one raw signal; the ranker percentile-normalizes it.
        engagement: fav * 3 + rt * 5 + Math.round(views / 20),
        createdAt: m.date ? Math.floor(Date.parse(String(m.date).replace(" ", "T") + "Z") / 1000) || 0 : 0,
        durationSec: typeof m.duration === "number" ? m.duration : undefined,
        downloadUrl: mediaUrl,
        downloadKind: "hls", // direct video.twimg.com URL → ffmpeg stream-copy
      });
    }
    logger.info({ platform: "x", hits: out.length }, "X search complete");
    return out;
  },
};
