// Scout service — orchestrates search → rank → download → probe, keeping job state in memory
// (downloaded files persist on disk; only the final Match Story clip is stored in the DB).
//
// Public surface: startScout / getScoutJob / setCandidateStatus / buildBeatsFromJob / listAdapters.

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getUploadsDir, downloadSocialClip, downloadHlsClip } from "../clipProcessor";
import { downloadSocialUrl, localUploadPath } from "../videoUnderstand";
import { logger } from "../logger";
import { probeFootage, judgeFootage, MIN_BEAT_SHORT_SIDE, MIN_BEAT_BITS_PER_PIXEL } from "../footageQuality";
export { MIN_BEAT_SHORT_SIDE, MIN_BEAT_BITS_PER_PIXEL };
import { redditAdapter } from "./reddit";
import { xAdapter } from "./x";
import { instagramAdapter } from "./instagram";
import { facebookAdapter } from "./facebook";
import { youtubeAdapter } from "./youtube";
import { buildQueryPlan } from "./query";
import { rankCandidates } from "./score";
import { readScoutConfig, cookieFileFor, type ScoutConfig } from "./config";
import type { ScoutAdapter, ScoutJob, ScoutOptions, RawCandidate, Platform } from "./types";

const execFileAsync = promisify(execFile);

// Registry — Reddit ships in Phase A; x/instagram/facebook adapters slot in behind the same
// interface in later phases without touching this file's logic.
const ADAPTERS: ScoutAdapter[] = [redditAdapter, xAdapter, instagramAdapter, facebookAdapter, youtubeAdapter];

const jobs = new Map<string, ScoutJob>();

export function listAdapters(): { platform: Platform; configured: boolean }[] {
  return ADAPTERS.map((a) => ({ platform: a.platform, configured: a.isConfigured() }));
}

export function getScoutJob(id: string): ScoutJob | undefined {
  return jobs.get(id);
}

export function setCandidateStatus(jobId: string, candId: string, status: "keep" | "drop"): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  const c = job.candidates.find((x) => x.id === candId);
  if (!c) return false;
  c.status = status;
  return true;
}

function cookieForPlatform(_cfg: ScoutConfig, p: Platform): string | undefined {
  // Every platform (Reddit included, now) needs a logged-in cookie to download via yt-dlp.
  return cookieFileFor(p);
}

async function makeThumb(src: string, out: string): Promise<string | undefined> {
  try {
    await execFileAsync("ffmpeg", ["-y", "-i", src, "-vf", "thumbnail=120", "-frames:v", "1", out], { timeout: 30_000 });
    return fs.existsSync(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Kick off a scout run in the background; returns the job immediately for polling. */
export function startScout(topic: string, opts: ScoutOptions): ScoutJob {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job: ScoutJob = { id, topic, options: opts, status: "searching", progress: 2, candidates: [], createdAt: Date.now() };
  jobs.set(id, job);
  void runScout(job);
  // Evict jobs older than 2h to bound memory.
  for (const [k, v] of jobs) if (Date.now() - v.createdAt > 2 * 3600_000) jobs.delete(k);
  return job;
}

async function runScout(job: ScoutJob): Promise<void> {
  try {
    const plan = buildQueryPlan(job.topic, job.options.subreddits);
    const enabled = ADAPTERS.filter((a) => job.options.platforms.includes(a.platform) && a.isConfigured());
    if (enabled.length === 0) { job.status = "error"; job.message = "No configured platforms selected."; return; }

    // Search every enabled platform, streaming the ranked shortlist to the poller as each
    // platform returns. NOTHING is downloaded here — we present ~40 candidates from metadata
    // (cheap) and only download the ones the user keeps, at approve time.
    job.status = "searching";
    const cap = job.options.maxCandidates ?? 40;
    const raw: RawCandidate[] = [];
    for (let i = 0; i < enabled.length; i++) {
      try {
        const hits = await enabled[i]!.search(job.topic, job.options);
        raw.push(...hits);
        logger.info({ jobId: job.id, platform: enabled[i]!.platform, hits: hits.length }, "Scout platform searched");
      } catch (e) {
        logger.warn({ e, platform: enabled[i]!.platform }, "Scout adapter search failed");
      }
      job.candidates = rankCandidates(raw, plan.terms, job.options).slice(0, cap).map((c) => ({ ...c, status: "candidate" as const }));
      job.progress = 5 + ((i + 1) / enabled.length) * 90;
    }

    job.candidates = rankCandidates(raw, plan.terms, job.options).slice(0, cap).map((c) => ({ ...c, status: "candidate" as const }));
    job.status = "ready";
    job.progress = 100;
    if (job.candidates.length === 0) job.message = "No matching video clips found. Try a broader topic, add platforms, or check the platform cookies.";
  } catch (e) {
    job.status = "error";
    job.message = e instanceof Error ? e.message : String(e);
    logger.error({ e, jobId: job.id }, "Scout run failed");
  }
}

/** Download the KEPT candidates NOW (only what the user chose) and build Match Story beats.
 * Runs at approve time; failed/too-long downloads are skipped. thumbUrl is the remote thumb for UI. */
export async function buildBeatsFromJob(jobId: string): Promise<{ beats: FetchedBeat[]; rejected: RejectedBeat[] }> {
  const job = jobs.get(jobId);
  if (!job) return { beats: [], rejected: [] };
  const kept = job.candidates.filter((c) => c.status === "keep");
  const uploads = getUploadsDir();
  const cfg = readScoutConfig();
  const toHMS = (s: number) => {
    const t = Math.max(1, Math.round(s));
    return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((n) => String(n).padStart(2, "0")).join(":");
  };
  const beats: { localFile: string; sourceType: "local"; startTime: string; endTime: string; headline: string; sourceChannel: string; narrationLine: string; thumbUrl: string | null; width: number | null; height: number | null; bitsPerPixel: number | null }[] = [];
  const rejected: RejectedBeat[] = [];
  for (let i = 0; i < kept.length; i++) {
    const c = kept[i]!;
    const shortUrl = c.sourceUrl.slice(0, 80);
    const file = path.join(uploads, `scout_${job.id}_${i}_${Date.now()}.mp4`);
    try {
      if (c.downloadKind === "hls" && c.downloadUrl) await downloadHlsClip(c.downloadUrl, file);
      else await downloadSocialClip(c.downloadUrl || c.sourceUrl, file, cookieForPlatform(cfg, c.platform));
      const meta = await probeFootage(file);
      if (meta.duration < 1 || meta.duration > 180) {
        try { fs.unlinkSync(file); } catch { /**/ }
        rejected.push({ url: shortUrl, reason: `duration ${Math.round(meta.duration)}s outside 1-180s` });
        continue;
      }
      // Same sharpness gate the connector path uses. This was MISSING here, so the in-app Scout
      // grid could pull soft footage into beats while /scout/fetch-urls rejected it — the
      // 1920x1080@519kbps (0.008 bpp) re-upload that shipped came in through a path like this.
      // Rejections are REPORTED, not silent: a kept candidate vanishing with no reason is how
      // the gap survived unnoticed.
      const verdict = judgeFootage(meta);
      if (!verdict.ok) {
        try { fs.unlinkSync(file); } catch { /**/ }
        rejected.push({ url: shortUrl, reason: verdict.reason });
        logger.warn({ url: shortUrl, width: meta.width, height: meta.height, bpp: meta.bitsPerPixel }, "Scout beat rejected by sharpness gate at approve");
        continue;
      }
      beats.push({
        localFile: file, sourceType: "local", startTime: "00:00:00", endTime: toHMS(meta.duration),
        headline: c.title.replace(/\s+/g, " ").slice(0, 80), sourceChannel: c.author, narrationLine: "",
        thumbUrl: c.thumbnail ?? null,
        width: meta.width ?? null, height: meta.height ?? null, bitsPerPixel: meta.bitsPerPixel ?? null,
      });
    } catch (e) {
      logger.warn({ e, url: shortUrl }, "Scout clip download failed at approve");
      rejected.push({ url: shortUrl, reason: "download failed" });
      try { fs.existsSync(file) && fs.unlinkSync(file); } catch { /**/ }
    }
  }
  return { beats, rejected };
}

/** Match Story 2.0 (Claude-driven): turn a PASTED list of beats (the ones Claude picked via the MCP
 * connector) into local Match Story beats. Each `url` is EITHER a social clip URL (downloaded whole)
 * OR an uploads path already fetched/segmented by the connector's download_clip / extract_segment
 * (used in place — the precise moment Claude cut). Each whole clip is one beat; failed/too-long
 * downloads are skipped. Mirrors buildBeatsFromJob but starts from bare URLs/paths. */
export type FetchedBeat = {
  localFile: string; sourceType: "local"; startTime: string; endTime: string;
  headline: string; sourceChannel: string; narrationLine: string; thumbUrl: string | null;
  width: number | null; height: number | null; bitsPerPixel: number | null;
};
export type RejectedBeat = { url: string; reason: string };

export async function buildBeatsFromUrls(
  items: { url: string; headline?: string; sourceChannel?: string; narrationLine?: string }[],
  opts: { minShortSide?: number; minBitsPerPixel?: number } = {},
): Promise<{ beats: FetchedBeat[]; rejected: RejectedBeat[] }> {
  const uploads = getUploadsDir();
  // 0 disables a floor entirely (for topics where no sharp footage exists at all).
  const minShort = opts.minShortSide ?? MIN_BEAT_SHORT_SIDE;
  const minBpp = opts.minBitsPerPixel ?? MIN_BEAT_BITS_PER_PIXEL;
  const toHMS = (s: number) => {
    const t = Math.max(1, Math.round(s));
    return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((n) => String(n).padStart(2, "0")).join(":");
  };
  const beats: FetchedBeat[] = [];
  const rejected: RejectedBeat[] = [];
  for (let i = 0; i < items.length && i < 8; i++) {
    const it = items[i]!;
    const shortUrl = it.url.slice(0, 80);
    // A clip already downloaded/segmented via the connector → its `url` is an uploads path; use it
    // directly (no re-download, and never delete it on reject — it's not ours to remove).
    const preExisting = localUploadPath(it.url);
    const file = preExisting ?? path.join(uploads, `ms2url_${Date.now()}_${i}.mp4`);
    const drop = () => { if (!preExisting) { try { fs.existsSync(file) && fs.unlinkSync(file); } catch { /**/ } } };
    try {
      if (!preExisting) await downloadSocialUrl(it.url, file);
      const meta = await probeFootage(file);
      if (meta.duration < 1 || meta.duration > 300) {
        drop();
        rejected.push({ url: shortUrl, reason: `duration ${Math.round(meta.duration)}s outside 1-300s` });
        continue;
      }
      // Sharpness gate — shared with the renderer's pre-flight so both paths agree.
      const verdict = judgeFootage(meta, { minShortSide: minShort, minBitsPerPixel: minBpp });
      if (!verdict.ok) {
        drop();
        rejected.push({ url: shortUrl, reason: verdict.reason });
        logger.warn({ url: shortUrl, width: meta.width, height: meta.height, bpp: meta.bitsPerPixel }, "MS2 beat rejected by sharpness gate");
        continue;
      }
      beats.push({
        localFile: file, sourceType: "local", startTime: "00:00:00", endTime: toHMS(meta.duration),
        headline: (it.headline ?? "").replace(/\s+/g, " ").slice(0, 80), sourceChannel: (it.sourceChannel ?? "").slice(0, 80),
        narrationLine: (it.narrationLine ?? "").replace(/\s+/g, " ").slice(0, 600), thumbUrl: null,
        width: meta.width ?? null, height: meta.height ?? null, bitsPerPixel: meta.bitsPerPixel ?? null,
      });
    } catch (e) {
      logger.warn({ e, url: shortUrl }, "MS2 pasted-URL download failed");
      rejected.push({ url: shortUrl, reason: "download failed" });
      drop();
    }
  }
  return { beats, rejected };
}
