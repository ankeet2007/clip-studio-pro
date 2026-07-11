// YouTube scout adapter — the day-of source.
//
// The official FOX/FIFA highlight (with the penalty miss, the heartbreak) is on YouTube hours
// before the Reddit/X threads fill. yt-dlp's `ytsearchdate` returns newest-first, so those uploads
// surface even 13h after a match. Search runs on the phone's HOME IP (yt-dlp), so YouTube's
// datacenter-IP blocks don't bite. Metadata-only (flat playlist) — nothing is downloaded here;
// download happens later via the whole-clip path, or moment-by-moment via extract_segment.

import fs from "fs";
import { execFile } from "child_process";
import type { Platform, RawCandidate, ScoutAdapter, ScoutOptions } from "./types";
import { buildQueryPlan } from "./query";
import { logger } from "../logger";

function findYtDlp(): string {
  for (const p of ["/home/runner/workspace/.pythonlibs/bin/yt-dlp", "/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp"]) {
    if (fs.existsSync(p)) return p;
  }
  return "yt-dlp";
}

// Map a freshness window to YouTube's search-filter token (the `sp=` param on the results page).
// These are stable, well-known upload-date filters; results within them are recent by construction,
// which is exactly what a day-of montage wants. `ytsearchdate` is NOT used — some yt-dlp builds
// reject it ("Unsupported url scheme"), whereas the results-page URL works everywhere.
function uploadDateSp(maxAgeHours: number): string {
  if (maxAgeHours <= 24) return "EgIIAg%3D%3D";   // Today
  if (maxAgeHours <= 168) return "EgIIAw%3D%3D";  // This week
  if (maxAgeHours <= 744) return "EgIIBA%3D%3D";  // This month
  return "CAI%3D";                                 // Sort by upload date (freshest first)
}

export const youtubeAdapter: ScoutAdapter = {
  platform: "youtube" as Platform,
  // Public search needs no cookie (the YOUTUBE_COOKIES env just unlocks HD on download).
  isConfigured() {
    return true;
  },
  async search(topic: string, opts: ScoutOptions): Promise<RawCandidate[]> {
    const plan = buildQueryPlan(topic, opts.subreddits);
    const limit = Math.min(40, Math.max(5, opts.maxPerPlatform ?? 40));
    const ytDlp = findYtDlp();
    // Freshness → the search-results URL with an upload-date filter; otherwise the plain ytsearch
    // prefix (relevance). Both return flat-playlist entries yt-dlp can parse with --dump-json.
    const args = ["--no-warnings", "--ignore-errors", "--flat-playlist", "--dump-json"];
    if (opts.maxAgeHours) {
      args.push("--playlist-end", String(limit),
        `https://www.youtube.com/results?search_query=${encodeURIComponent(plan.primary)}&sp=${uploadDateSp(opts.maxAgeHours)}`);
    } else {
      args.push(`ytsearch${limit}:${plan.primary}`);
    }

    const json = await new Promise<string>((resolve) => {
      execFile(
        ytDlp,
        args,
        { timeout: 90_000, maxBuffer: 48 * 1024 * 1024 },
        (_err, stdout) => resolve(stdout || ""), // stderr is just per-entry warnings — ignore
      );
    });

    const out: RawCandidate[] = [];
    const seen = new Set<string>();
    for (const line of json.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let e: Record<string, any>;
      try { e = JSON.parse(line) as Record<string, any>; } catch { continue; }
      const id = String(e.id ?? "");
      // Keep only real VIDEO ids (11 chars) — flat search results can include channels/playlists.
      if (!/^[\w-]{11}$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      const duration = typeof e.duration === "number" ? e.duration : undefined;
      // flat-playlist rarely carries an upload timestamp — 0 = unknown (ytsearchdate ordering
      // still fronts the freshest, and the ranker/age-filter treat unknown dates as neutral).
      const createdAt = typeof e.timestamp === "number" ? e.timestamp : 0;
      const views = Number(e.view_count ?? 0);
      const thumb =
        Array.isArray(e.thumbnails) && e.thumbnails.length
          ? String(e.thumbnails[e.thumbnails.length - 1]?.url ?? "")
          : (typeof e.thumbnail === "string" ? e.thumbnail : undefined);
      out.push({
        platform: "youtube",
        sourceUrl: `https://www.youtube.com/watch?v=${id}`,
        title: String(e.title ?? "").slice(0, 300),
        author: String(e.channel ?? e.uploader ?? "youtube"),
        engagement: views,
        createdAt,
        durationSec: duration,
        thumbnail: thumb || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        downloadUrl: `https://www.youtube.com/watch?v=${id}`,
        downloadKind: "ytdlp",
      });
    }
    logger.info({ platform: "youtube", hits: out.length, fresh: !!opts.maxAgeHours }, "YouTube search complete");
    return out;
  },
};
