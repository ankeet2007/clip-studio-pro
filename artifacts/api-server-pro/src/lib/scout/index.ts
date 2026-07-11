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

async function probeMedia(file: string): Promise<{ duration: number; width?: number; height?: number; hasAudio: boolean }> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height",
      "-of", "json", file,
    ], { timeout: 30_000 });
    const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number }[] };
    const v = (j.streams ?? []).find((s) => s.codec_type === "video");
    const hasAudio = (j.streams ?? []).some((s) => s.codec_type === "audio");
    return { duration: parseFloat(j.format?.duration ?? "0") || 0, width: v?.width, height: v?.height, hasAudio };
  } catch {
    return { duration: 0, hasAudio: false };
  }
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
export async function buildBeatsFromJob(jobId: string): Promise<{ localFile: string; sourceType: "local"; startTime: string; endTime: string; headline: string; sourceChannel: string; narrationLine: string; thumbUrl: string | null }[]> {
  const job = jobs.get(jobId);
  if (!job) return [];
  const kept = job.candidates.filter((c) => c.status === "keep");
  const uploads = getUploadsDir();
  const cfg = readScoutConfig();
  const toHMS = (s: number) => {
    const t = Math.max(1, Math.round(s));
    return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((n) => String(n).padStart(2, "0")).join(":");
  };
  const beats: { localFile: string; sourceType: "local"; startTime: string; endTime: string; headline: string; sourceChannel: string; narrationLine: string; thumbUrl: string | null }[] = [];
  for (let i = 0; i < kept.length; i++) {
    const c = kept[i]!;
    const file = path.join(uploads, `scout_${job.id}_${i}_${Date.now()}.mp4`);
    try {
      if (c.downloadKind === "hls" && c.downloadUrl) await downloadHlsClip(c.downloadUrl, file);
      else await downloadSocialClip(c.downloadUrl || c.sourceUrl, file, cookieForPlatform(cfg, c.platform));
      const meta = await probeMedia(file);
      if (meta.duration < 1 || meta.duration > 180) { try { fs.unlinkSync(file); } catch { /**/ } continue; }
      beats.push({
        localFile: file, sourceType: "local", startTime: "00:00:00", endTime: toHMS(meta.duration),
        headline: c.title.replace(/\s+/g, " ").slice(0, 80), sourceChannel: c.author, narrationLine: "",
        thumbUrl: c.thumbnail ?? null,
      });
    } catch (e) {
      logger.warn({ e, url: c.sourceUrl.slice(0, 80) }, "Scout clip download failed at approve");
      try { fs.existsSync(file) && fs.unlinkSync(file); } catch { /**/ }
    }
  }
  return beats;
}

/** Match Story 2.0 (Claude-driven): turn a PASTED list of beats (the ones Claude picked via the MCP
 * connector) into local Match Story beats. Each `url` is EITHER a social clip URL (downloaded whole)
 * OR an uploads path already fetched/segmented by the connector's download_clip / extract_segment
 * (used in place — the precise moment Claude cut). Each whole clip is one beat; failed/too-long
 * downloads are skipped. Mirrors buildBeatsFromJob but starts from bare URLs/paths. */
export async function buildBeatsFromUrls(items: { url: string; headline?: string; sourceChannel?: string; narrationLine?: string }[]): Promise<{ localFile: string; sourceType: "local"; startTime: string; endTime: string; headline: string; sourceChannel: string; narrationLine: string; thumbUrl: string | null }[]> {
  const uploads = getUploadsDir();
  const toHMS = (s: number) => {
    const t = Math.max(1, Math.round(s));
    return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((n) => String(n).padStart(2, "0")).join(":");
  };
  const beats: { localFile: string; sourceType: "local"; startTime: string; endTime: string; headline: string; sourceChannel: string; narrationLine: string; thumbUrl: string | null }[] = [];
  for (let i = 0; i < items.length && i < 8; i++) {
    const it = items[i]!;
    // A clip already downloaded/segmented via the connector → its `url` is an uploads path; use it
    // directly (no re-download, and never delete it on reject — it's not ours to remove).
    const preExisting = localUploadPath(it.url);
    const file = preExisting ?? path.join(uploads, `ms2url_${Date.now()}_${i}.mp4`);
    try {
      if (!preExisting) await downloadSocialUrl(it.url, file);
      const meta = await probeMedia(file);
      if (meta.duration < 1 || meta.duration > 300) { if (!preExisting) { try { fs.unlinkSync(file); } catch { /**/ } } continue; }
      beats.push({
        localFile: file, sourceType: "local", startTime: "00:00:00", endTime: toHMS(meta.duration),
        headline: (it.headline ?? "").replace(/\s+/g, " ").slice(0, 80), sourceChannel: (it.sourceChannel ?? "").slice(0, 80),
        narrationLine: (it.narrationLine ?? "").replace(/\s+/g, " ").slice(0, 600), thumbUrl: null,
      });
    } catch (e) {
      logger.warn({ e, url: it.url.slice(0, 80) }, "MS2 pasted-URL download failed");
      if (!preExisting) { try { fs.existsSync(file) && fs.unlinkSync(file); } catch { /**/ } }
    }
  }
  return beats;
}
