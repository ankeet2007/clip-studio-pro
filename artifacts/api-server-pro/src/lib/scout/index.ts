// Scout service — orchestrates search → rank → download → probe, keeping job state in memory
// (downloaded files persist on disk; only the final Match Story clip is stored in the DB).
//
// Public surface: startScout / getScoutJob / setCandidateStatus / buildBeatsFromJob / listAdapters.

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getUploadsDir, downloadSocialClip, downloadHlsClip } from "../clipProcessor";
import { logger } from "../logger";
import { redditAdapter } from "./reddit";
import { xAdapter } from "./x";
import { instagramAdapter } from "./instagram";
import { facebookAdapter } from "./facebook";
import { buildQueryPlan } from "./query";
import { rankCandidates } from "./score";
import { readScoutConfig, cookieFileFor, type ScoutConfig } from "./config";
import type { ScoutAdapter, ScoutJob, ScoutOptions, RawCandidate, DownloadedCandidate, Platform } from "./types";

const execFileAsync = promisify(execFile);

// Registry — Reddit ships in Phase A; x/instagram/facebook adapters slot in behind the same
// interface in later phases without touching this file's logic.
const ADAPTERS: ScoutAdapter[] = [redditAdapter, xAdapter, instagramAdapter, facebookAdapter];

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

    // 1) Search every enabled platform.
    job.status = "searching";
    const raw: RawCandidate[] = [];
    for (let i = 0; i < enabled.length; i++) {
      try {
        const hits = await enabled[i]!.search(job.topic, job.options);
        raw.push(...hits);
        logger.info({ jobId: job.id, platform: enabled[i]!.platform, hits: hits.length }, "Scout platform searched");
      } catch (e) {
        logger.warn({ e, platform: enabled[i]!.platform }, "Scout adapter search failed");
      }
      job.progress = 2 + ((i + 1) / enabled.length) * 30;
    }

    // 2) Rank + de-dup, then take the top N to actually download.
    const ranked = rankCandidates(raw, plan.terms, job.options);
    const toDownload = ranked.slice(0, Math.min(12, job.options.maxDownload ?? 8));
    if (toDownload.length === 0) { job.status = "ready"; job.progress = 100; job.message = "No matching video clips found. Try a broader topic, add platforms, or add creds/cookies."; return; }

    // 3) Download + probe sequentially (memory-safe on the phone), streaming results as they land.
    job.status = "downloading";
    const uploads = getUploadsDir();
    const cfg = readScoutConfig();
    const minD = job.options.minDurationSec ?? 3;
    const maxD = job.options.maxDurationSec ?? 60;
    const out: DownloadedCandidate[] = [];
    for (let i = 0; i < toDownload.length; i++) {
      const c = toDownload[i]!;
      const file = path.join(uploads, `scout_${job.id}_${i}.mp4`);
      try {
        if (c.downloadKind === "hls" && c.downloadUrl) {
          await downloadHlsClip(c.downloadUrl, file);
        } else {
          await downloadSocialClip(c.downloadUrl || c.sourceUrl, file, cookieForPlatform(cfg, c.platform));
        }
        const meta = await probeMedia(file);
        if (meta.duration < 1 || meta.duration > 180) { try { fs.unlinkSync(file); } catch { /**/ } continue; }
        const thumbFile = await makeThumb(file, path.join(uploads, `scout_${job.id}_${i}.jpg`));
        // Refine quality now that we know real duration/resolution.
        const inWindow = meta.duration >= minD && meta.duration <= maxD;
        const hd = (meta.height ?? 0) >= 480;
        const quality = (inWindow ? 0.6 : 0.25) + (hd ? 0.4 : 0.1);
        const reasons = [...c.reasons, `${Math.round(meta.duration)}s`, `${meta.width ?? "?"}x${meta.height ?? "?"}`, meta.hasAudio ? "has audio" : "no audio"];
        out.push({ ...c, localFile: file, durationSec: meta.duration, width: meta.width, height: meta.height, thumbFile, status: "candidate", scores: { ...c.scores, quality }, reasons });
      } catch (e) {
        logger.warn({ e, url: c.sourceUrl.slice(0, 80) }, "Scout clip download failed");
        try { fs.existsSync(file) && fs.unlinkSync(file); } catch { /**/ }
      }
      job.candidates = out.slice(); // stream partial progress to the poller
      job.progress = 35 + ((i + 1) / toDownload.length) * 60;
    }

    job.candidates = out;
    job.status = "ready";
    job.progress = 100;
    if (out.length === 0) job.message = "Found posts but none downloaded (private/removed/geo-blocked). Try again or widen the search.";
  } catch (e) {
    job.status = "error";
    job.message = e instanceof Error ? e.message : String(e);
    logger.error({ e, jobId: job.id }, "Scout run failed");
  }
}

/** Build Match Story beats from the KEPT candidates of a finished scout job. */
export function buildBeatsFromJob(jobId: string): { localFile: string; sourceType: "local"; startTime: string; endTime: string; headline: string; sourceChannel: string; narrationLine: string }[] {
  const job = jobs.get(jobId);
  if (!job) return [];
  const kept = job.candidates.filter((c) => c.status === "keep");
  const toHMS = (s: number) => {
    const t = Math.max(1, Math.round(s));
    return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((n) => String(n).padStart(2, "0")).join(":");
  };
  return kept.map((c) => ({
    localFile: c.localFile,
    sourceType: "local" as const,
    startTime: "00:00:00",
    endTime: toHMS(c.durationSec),
    headline: c.title.replace(/\s+/g, " ").slice(0, 80),
    sourceChannel: c.author,
    narrationLine: "",
  }));
}
