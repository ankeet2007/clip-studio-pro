// Instagram scout adapter (Phase B) — best-effort, the weakest platform.
//
// Instagram has no text search, so we search HASHTAGS derived from the topic (via gallery-dl +
// the user's cookie). Results are recent-not-viral and often off-topic, so the relevance floor
// in the ranker does a lot of filtering. Reels are downloaded by yt-dlp on the post URL (more
// reliable than the short-lived fbcdn CDN URL).

import fs from "fs";
import { execFile } from "child_process";
import type { Platform, RawCandidate, ScoutAdapter, ScoutOptions } from "./types";
import { cookieFileFor } from "./config";
import { buildQueryPlan } from "./query";
import { logger } from "../logger";

function findGalleryDl(): string {
  for (const p of ["/data/data/com.termux/files/usr/bin/gallery-dl", "/usr/local/bin/gallery-dl", "/usr/bin/gallery-dl"]) {
    if (fs.existsSync(p)) return p;
  }
  return "gallery-dl";
}

function hashtagsFor(topic: string, plan: ReturnType<typeof buildQueryPlan>): string[] {
  const joined = topic.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const tags = [joined, ...plan.terms.map((t) => t.replace(/[^a-z0-9]/g, ""))].filter((t) => t.length >= 3);
  return Array.from(new Set(tags)).slice(0, 3);
}

async function tagSearch(gdl: string, cookie: string, tag: string, limit: number): Promise<unknown[]> {
  const json = await new Promise<string>((resolve) => {
    execFile(gdl, ["--cookies", cookie, "-j", "--range", `1-${limit}`, `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`],
      { timeout: 75_000, maxBuffer: 32 * 1024 * 1024 }, (_e, stdout) => resolve(stdout || "[]"));
  });
  try { return JSON.parse(json); } catch { return []; }
}

export const instagramAdapter: ScoutAdapter = {
  platform: "instagram" as Platform,
  isConfigured() {
    return !!cookieFileFor("instagram");
  },
  async search(topic: string, opts: ScoutOptions): Promise<RawCandidate[]> {
    const cookie = cookieFileFor("instagram");
    if (!cookie) return [];
    const gdl = findGalleryDl();
    const plan = buildQueryPlan(topic, opts.subreddits);
    const tags = hashtagsFor(topic, plan);
    const perTag = Math.min(25, Math.ceil((opts.maxPerPlatform ?? 30) / Math.max(1, tags.length)));

    const out: RawCandidate[] = [];
    const seen = new Set<string>();
    for (const tag of tags) {
      let entries: unknown[] = [];
      try { entries = await tagSearch(gdl, cookie, tag, perTag); } catch { entries = []; }
      for (const e of entries) {
        if (!Array.isArray(e) || e.length < 3 || e[0] !== 3) continue;
        const m = (e[2] ?? {}) as Record<string, any>;
        if (!m.video_url && !String(e[1] ?? "").includes("t39.")) continue; // videos only
        const shortcode = String(m.shortcode ?? m.post_shortcode ?? "");
        if (!shortcode || seen.has(shortcode)) continue;
        seen.add(shortcode);
        out.push({
          platform: "instagram",
          sourceUrl: `https://www.instagram.com/reel/${shortcode}/`,
          title: String(m.description ?? m.caption ?? "").replace(/\s+/g, " ").slice(0, 300),
          author: m.username ? `@${m.username}` : (m.owner?.username ? `@${m.owner.username}` : "instagram"),
          engagement: Number(m.likes ?? 0) + Number(m.comments ?? 0) * 2,
          createdAt: m.date ? Math.floor(Date.parse(String(m.date).replace(" ", "T") + "Z") / 1000) || 0 : 0,
          durationSec: typeof m.video_duration === "number" ? m.video_duration : undefined,
          downloadUrl: `https://www.instagram.com/reel/${shortcode}/`,
          downloadKind: "ytdlp", // yt-dlp + IG cookie is more reliable than the expiring CDN url
        });
      }
    }
    logger.info({ platform: "instagram", tags, hits: out.length }, "Instagram search complete");
    return out;
  },
};
