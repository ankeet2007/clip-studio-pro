// "Understand a social video" for the Claude MCP connector.
//
// Given a Reddit / X / Instagram / Facebook video URL, download the clip and turn it into
// something the (multimodal) Claude on the other end of the connector can read directly:
//   • a handful of evenly-spaced KEYFRAMES (jpeg) — Claude's own vision describes the action, and
//   • a local whisper.cpp TRANSCRIPT of the audio (commentary / speech).
// No external API/key: ffmpeg + whisper-cli are already on the phone. Everything is best-effort and
// time-bounded so a slow download or a long clip can never hang the connector — frames come back
// even if the transcript is skipped.

import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { downloadSocialClip, downloadHlsClip } from "./clipProcessor";
import { cookieFileFor, cookieHeaderFor } from "./scout/config";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);

const UA = "clip-studio-pro:understand:v1 (by /u/clipstudio)";
const HOME = os.homedir();
const WHISPER_BIN = process.env["WHISPER_BIN"] || path.join(HOME, "whisper.cpp/build/bin/whisper-cli");
const WHISPER_LIB = path.dirname(WHISPER_BIN);
// tiny.en, not small.en: on the low-end phone CPU, small.en took >90s for a 6s clip (unusable
// interactively) while tiny.en does it in ~9s incl. model load. Quality is lower but it's only for
// gist/commentary — the keyframes carry the visual understanding. Override via env if desired.
const WHISPER_MODEL = process.env["UNDERSTAND_WHISPER_MODEL"] || path.join(HOME, "whisper.cpp/models/ggml-tiny.en.bin");
const TRANSCRIBE_CAP_SEC = 60; // only transcribe the first minute — bounds whisper time on long clips
const OVERALL_BUDGET_MS = 55_000;

export type UnderstandPlatform = "reddit" | "x" | "instagram" | "facebook";

export interface VideoUnderstanding {
  platform: UnderstandPlatform;
  durationSec: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  transcript: string | null;
  transcriptTruncated: boolean;
  frames: { dataBase64: string; mimeType: string }[];
  notes: string[];
}

export function detectPlatform(url: string): UnderstandPlatform | null {
  let host: string;
  try {
    const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    host = new URL(withProto).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (host === "redd.it" || host.endsWith("reddit.com") || host.endsWith("redd.it")) return "reddit";
  if (host === "x.com" || host.endsWith(".x.com") || host.endsWith("twitter.com") || host === "t.co") return "x";
  if (host.endsWith("instagram.com")) return "instagram";
  if (host.endsWith("facebook.com") || host === "fb.watch" || host === "fb.me") return "facebook";
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms); }),
  ]);
}

async function probe(file: string): Promise<{ duration: number; width?: number; height?: number; hasAudio: boolean }> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file,
    ], { timeout: 20_000 });
    const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number }[] };
    const v = (j.streams ?? []).find((s) => s.codec_type === "video");
    const hasAudio = (j.streams ?? []).some((s) => s.codec_type === "audio");
    return { duration: parseFloat(j.format?.duration ?? "0") || 0, width: v?.width, height: v?.height, hasAudio };
  } catch {
    return { duration: 0, hasAudio: false };
  }
}

/** Reddit: resolve the v.redd.it HLS from the post JSON (avoids yt-dlp's IP-blocked Reddit API);
 *  fall back to yt-dlp + the reddit cookie. */
async function downloadReddit(url: string, out: string): Promise<void> {
  try {
    const jsonUrl = url.split(/[?#]/)[0]!.replace(/\/$/, "") + ".json";
    const headers: Record<string, string> = { "User-Agent": UA };
    const cookie = cookieHeaderFor("reddit", /reddit\.com$/i);
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(jsonUrl, { headers });
    if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
      const j = (await res.json()) as any;
      const post = j?.[0]?.data?.children?.[0]?.data ?? {};
      const rv = post?.media?.reddit_video ?? post?.crosspost_parent_list?.[0]?.media?.reddit_video;
      const hls = rv?.hls_url ? String(rv.hls_url).replace(/&amp;/g, "&") : undefined;
      if (hls) { await downloadHlsClip(hls, out); return; }
    }
  } catch (e) {
    logger.warn({ e }, "understand: reddit JSON→HLS resolve failed, falling back to yt-dlp");
  }
  await downloadSocialClip(url, out, cookieFileFor("reddit"));
}

/** Download a full reddit/x/ig/fb clip to `out`. Reddit resolves the v.redd.it HLS from the post
 *  JSON (avoids yt-dlp's IP-blocked Reddit API); the others use yt-dlp + the platform cookie.
 *  Shared by understand_video AND Match Story 2.0's paste-and-render (buildBeatsFromUrls). */
export async function downloadSocialUrl(url: string, out: string): Promise<UnderstandPlatform> {
  const platform = detectPlatform(url);
  if (!platform) throw new Error("Unsupported URL. Provide a Reddit, X/Twitter, Instagram or Facebook video link.");
  if (platform === "reddit") await downloadReddit(url, out);
  else await downloadSocialClip(url, out, cookieFileFor(platform));
  return platform;
}

// Detect scene-change timestamps with ONE fast, low-res, time-capped decode pass. Scaling to a
// tiny size makes the decode cheap on the weak phone CPU, and the pts_time is the SOURCE timestamp
// so downscaling doesn't move it. Best-effort — any failure/timeout yields [] (→ evenly-spaced).
async function sceneTimestamps(file: string, duration: number, budgetMs: number): Promise<number[]> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-t", String(Math.min(45, Math.max(1, Math.ceil(duration) || 45))), "-i", file, "-an",
      "-vf", "scale=192:-2,select='gt(scene,0.30)',showinfo", "-f", "null", "-",
    ], { timeout: budgetMs, maxBuffer: 16 * 1024 * 1024 });
    const ts: number[] = [];
    const re = /pts_time:([0-9.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stderr)) !== null) {
      const t = parseFloat(m[1]!);
      if (Number.isFinite(t) && t >= 0 && t <= duration) ts.push(t);
    }
    return ts;
  } catch {
    return [];
  }
}

// Choose n frame timestamps spread across the clip but biased to real action: split the clip into
// n equal windows and, per window, take the scene-cut nearest its centre when there is one, else
// the window centre. Guarantees coverage of the setup (first window) and the result (last window)
// while landing frames on the moments where something actually changes on screen.
function pickFrameTimes(scenes: number[], duration: number, n: number): number[] {
  if (duration <= 0) return [0];
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = (i / n) * duration;
    const hi = ((i + 1) / n) * duration;
    const mid = (lo + hi) / 2;
    const inWin = scenes.filter((t) => t >= lo && t < hi).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    times.push(inWin.length ? inWin[0]! : mid);
  }
  return times;
}

async function extractFramesAt(file: string, times: number[], dir: string): Promise<{ dataBase64: string; mimeType: string }[]> {
  const frames: { dataBase64: string; mimeType: string }[] = [];
  for (let i = 0; i < times.length; i++) {
    const ts = Math.max(0, times[i]!);
    const out = path.join(dir, `frame_${i}.jpg`);
    try {
      // Input-seek (-ss before -i) is fast; scale to 512px wide (even height) at moderate JPEG
      // quality — big enough to read shirt numbers / the scoreboard, small enough for the payload.
      await execFileAsync("ffmpeg", ["-y", "-ss", ts.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "5", out], { timeout: 15_000 });
      if (fs.existsSync(out)) {
        frames.push({ dataBase64: fs.readFileSync(out).toString("base64"), mimeType: "image/jpeg" });
        fs.unlinkSync(out);
      }
    } catch (e) {
      logger.warn({ e, i }, "understand: frame extraction failed");
    }
  }
  return frames;
}

// Pull the first TRANSCRIBE_CAP_SEC of audio as 16kHz mono wav — the shared input for whichever
// transcriber (cloud medium.en or local tiny.en) runs.
async function extractWav(file: string, dir: string): Promise<string> {
  const wav = path.join(dir, "audio.wav");
  await execFileAsync("ffmpeg", ["-y", "-t", String(TRANSCRIBE_CAP_SEC), "-i", file, "-ar", "16000", "-ac", "1", "-vn", wav], { timeout: 20_000 });
  return wav;
}

async function localTranscribe(wav: string, dir: string, budgetMs: number): Promise<string> {
  const ofPrefix = path.join(dir, "tr");
  await execFileAsync(WHISPER_BIN, ["-m", WHISPER_MODEL, "-f", wav, "-nt", "-np", "-otxt", "-of", ofPrefix, "-t", "4"], {
    timeout: budgetMs,
    env: { ...process.env, LD_LIBRARY_PATH: `${WHISPER_LIB}:${process.env["LD_LIBRARY_PATH"] ?? ""}` },
    maxBuffer: 8 * 1024 * 1024,
  });
  return fs.readFileSync(`${ofPrefix}.txt`, "utf8").replace(/\s+/g, " ").trim();
}

// When the render cloud is ON, transcribe on the worker's medium.en (much sharper on names / scores
// / minute-marks than the phone's tiny.en). ASYNC submit→poll (each request short, so the cloud's
// ~100s tunnel timeout never cuts a long medium.en pass) with a generous overall deadline, so LONGER
// clips are never rejected. Health-gated; ANY problem (cloud off/unreachable/error/deadline) returns
// null so the caller falls back to the phone's local tiny.en. Reuses CLOUD_RENDER_URL/SECRET.
async function cloudTranscribe(wav: string): Promise<string | null> {
  const base = process.env["CLOUD_RENDER_URL"];
  if (!base) return null;
  const secret = process.env["CLOUD_RENDER_SECRET"] || "";
  const fetchT = async (u: URL, init: RequestInit, ms: number): Promise<Response | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(u, { ...init, signal: ctrl.signal }); }
    catch { return null; }
    finally { clearTimeout(timer); }
  };
  try {
    // Fast health gate → cloud off/unreachable ⇒ null ⇒ caller uses local tiny.en in ~3.5s.
    const health = await fetchT(new URL("/health", base), {}, 3500);
    if (!health || !health.ok) return null;
    // Submit the wav; the worker runs medium.en in the background and hands back a jobId.
    const submit = await fetchT(new URL("/worker/transcribe-job", base), {
      method: "POST", headers: { "content-type": "audio/wav", "x-worker-secret": secret }, body: fs.readFileSync(wav),
    }, 30_000);
    if (!submit || !submit.ok) return null;
    const { jobId } = (await submit.json()) as { jobId?: string };
    if (!jobId) return null;
    // Poll (short requests) until done. Generous 5-min deadline so a long clip is never rejected.
    const statusUrl = new URL(`/worker/transcribe-job/${encodeURIComponent(jobId)}`, base);
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      const st = await fetchT(statusUrl, { headers: { "x-worker-secret": secret } }, 15_000);
      if (!st || !st.ok) continue;
      const j = (await st.json()) as { status?: string; transcript?: string };
      if (j.status === "done") return (j.transcript ?? "").replace(/\s+/g, " ").trim() || null;
      if (j.status === "error") return null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function understandVideo(url: string, maxFrames = 5): Promise<VideoUnderstanding> {
  const platform = detectPlatform(url);
  if (!platform) throw new Error("Unsupported URL. Provide a Reddit, X/Twitter, Instagram or Facebook video link.");

  const started = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "understand_"));
  const file = path.join(dir, "clip.mp4");
  const notes: string[] = [];
  try {
    await withTimeout(downloadSocialUrl(url, file), 40_000, "Download").catch((e) => {
      throw new Error(`Couldn't download the clip (${e instanceof Error ? e.message : e}). The platform cookie may be missing or expired.`);
    });
    const meta = await probe(file);

    const n = Math.min(8, Math.max(1, maxFrames));
    // Find the action moments (scene cuts) with a fast, bounded pass — but only if enough of the
    // overall budget remains to still leave room for the transcript; otherwise fall back cleanly to
    // evenly-spaced frames (scenes = []).
    let scenes: number[] = [];
    if (meta.duration >= 3) {
      const sceneBudget = Math.min(15_000, OVERALL_BUDGET_MS - (Date.now() - started) - 22_000);
      if (sceneBudget >= 5000) scenes = await sceneTimestamps(file, meta.duration, sceneBudget);
    }
    const frames = meta.duration >= 2
      ? await extractFramesAt(file, pickFrameTimes(scenes, meta.duration, n), dir)
      : await extractFramesAt(file, [Math.max(0, meta.duration / 2)], dir);
    if (scenes.length >= 5) notes.push(`action-heavy: ${scenes.length} scene changes detected — the keyframes target those moments`);
    else if (meta.duration > 6 && scenes.length <= 1) notes.push("low visual motion (few/no scene changes) — likely static, a talking-head, or a graphic; verify it shows real action before using");

    let transcript: string | null = null;
    let transcriptTruncated = false;
    if (meta.hasAudio) {
      try {
        const wav = await extractWav(file, dir);
        transcriptTruncated = meta.duration > TRANSCRIBE_CAP_SEC;
        // Prefer the cloud worker's medium.en when the render cloud is on; else local tiny.en.
        const cloud = await cloudTranscribe(wav);
        if (cloud) {
          transcript = cloud;
          notes.push("transcript via cloud medium.en (sharper names/numbers)");
        } else {
          const remaining = OVERALL_BUDGET_MS - (Date.now() - started) - 2000;
          const budget = Math.min(30_000, remaining);
          if (budget >= 8000 && fs.existsSync(WHISPER_BIN) && fs.existsSync(WHISPER_MODEL)) {
            transcript = (await localTranscribe(wav, dir, budget)) || null;
          } else if (budget < 8000) {
            notes.push("skipped transcript (download left too little time budget)");
          } else {
            notes.push("transcript unavailable (whisper not found on server)");
          }
        }
      } catch (e) {
        notes.push("audio transcript unavailable (transcription timed out or failed)");
        logger.warn({ e }, "understand: transcription failed");
      }
    }

    logger.info({ platform, duration: meta.duration, frames: frames.length, transcript: transcript ? transcript.length : 0 }, "understand: done");
    return { platform, durationSec: meta.duration, width: meta.width, height: meta.height, hasAudio: meta.hasAudio, transcript, transcriptTruncated, frames, notes };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
}
