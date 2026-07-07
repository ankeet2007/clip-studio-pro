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

function detectPlatform(url: string): UnderstandPlatform | null {
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

async function download(platform: UnderstandPlatform, url: string, out: string): Promise<void> {
  if (platform === "reddit") return downloadReddit(url, out);
  return void (await downloadSocialClip(url, out, cookieFileFor(platform)));
}

async function extractFrames(file: string, duration: number, dir: string, n: number): Promise<{ dataBase64: string; mimeType: string }[]> {
  const frames: { dataBase64: string; mimeType: string }[] = [];
  const count = duration >= 2 ? n : 1;
  for (let i = 0; i < count; i++) {
    const ts = duration > 0 ? duration * ((i + 0.5) / count) : 0;
    const out = path.join(dir, `frame_${i}.jpg`);
    try {
      // Input-seek (-ss before -i) is fast; scale to 480px wide (even height) and moderate JPEG
      // quality to keep the base64 payload small enough for the tool result.
      await execFileAsync("ffmpeg", ["-y", "-ss", ts.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "6", out], { timeout: 15_000 });
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

async function transcribe(file: string, dir: string, budgetMs: number): Promise<string> {
  const wav = path.join(dir, "audio.wav");
  await execFileAsync("ffmpeg", ["-y", "-t", String(TRANSCRIBE_CAP_SEC), "-i", file, "-ar", "16000", "-ac", "1", "-vn", wav], { timeout: 20_000 });
  const ofPrefix = path.join(dir, "tr");
  await execFileAsync(WHISPER_BIN, ["-m", WHISPER_MODEL, "-f", wav, "-nt", "-np", "-otxt", "-of", ofPrefix, "-t", "4"], {
    timeout: budgetMs,
    env: { ...process.env, LD_LIBRARY_PATH: `${WHISPER_LIB}:${process.env["LD_LIBRARY_PATH"] ?? ""}` },
    maxBuffer: 8 * 1024 * 1024,
  });
  const txt = fs.readFileSync(`${ofPrefix}.txt`, "utf8").replace(/\s+/g, " ").trim();
  return txt;
}

export async function understandVideo(url: string, maxFrames = 5): Promise<VideoUnderstanding> {
  const platform = detectPlatform(url);
  if (!platform) throw new Error("Unsupported URL. Provide a Reddit, X/Twitter, Instagram or Facebook video link.");

  const started = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "understand_"));
  const file = path.join(dir, "clip.mp4");
  const notes: string[] = [];
  try {
    await withTimeout(download(platform, url, file), 40_000, "Download").catch((e) => {
      throw new Error(`Couldn't download the clip (${e instanceof Error ? e.message : e}). The platform cookie may be missing or expired.`);
    });
    const meta = await probe(file);

    const frames = await extractFrames(file, meta.duration, dir, Math.min(8, Math.max(1, maxFrames)));

    let transcript: string | null = null;
    let transcriptTruncated = false;
    if (meta.hasAudio) {
      const remaining = OVERALL_BUDGET_MS - (Date.now() - started) - 3000;
      const budget = Math.min(30_000, remaining);
      if (budget >= 8000 && fs.existsSync(WHISPER_BIN) && fs.existsSync(WHISPER_MODEL)) {
        try {
          transcript = await transcribe(file, dir, budget);
          transcriptTruncated = meta.duration > TRANSCRIBE_CAP_SEC;
          if (!transcript) transcript = null;
        } catch (e) {
          notes.push("audio transcript unavailable (transcription timed out or failed)");
          logger.warn({ e }, "understand: transcription failed");
        }
      } else if (budget < 8000) {
        notes.push("skipped transcript (download left too little time budget)");
      } else {
        notes.push("transcript unavailable (whisper not found on server)");
      }
    }

    logger.info({ platform, duration: meta.duration, frames: frames.length, transcript: transcript ? transcript.length : 0 }, "understand: done");
    return { platform, durationSec: meta.duration, width: meta.width, height: meta.height, hasAudio: meta.hasAudio, transcript, transcriptTruncated, frames, notes };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
}
