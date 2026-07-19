import { execFile, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import os from "os";
import http from "http";
import https from "https";
import { inArray, eq } from "drizzle-orm";
import { db, clipsTable } from "@workspace/db-pro";
import { logger } from "./logger";
import { parseWhisperWords, planFillerCuts, findWordTime, type Word } from "./cutEngine";
import { applyPronunciation } from "./pronunciation";
import { probeFootage, judgeFootage } from "./footageQuality";

const execFileAsync = promisify(execFile);

const OUTPUT_DIR = process.env.CLIPS_OUTPUT_DIR ?? path.join(os.homedir(), "myapp", "clips_output");
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(os.homedir(), "myapp", "uploads");
const FONTS_DIR = path.join(findWorkspaceRoot(), "assets", "fonts");
const WATERMARK_FONT = path.join(FONTS_DIR, "Sora-SemiBold.ttf");
const ANTON_FONT = path.join(FONTS_DIR, "Anton-Regular.ttf");
// Light, low-center watermark burned on EVERY frame of a finished clip (deters reposting of scraped
// YouTube uploads). Drawn in the caption-burn re-encode so it costs no extra pass.
const WATERMARK_HANDLE = "@theycallmeashot";
const COOKIES_FILE = path.join(os.tmpdir(), "youtube_cookies.txt");

/**
 * If the YOUTUBE_COOKIES env var is set, writes its content to a temp file
 * and returns ["--cookies", "<path>"] to append to the yt-dlp command.
 * This unlocks higher-quality formats on live recordings and age-restricted videos.
 */
function getCookiesArgs(): string[] {
  const cookies = process.env.YOUTUBE_COOKIES;
  if (!cookies || !cookies.trim()) return [];
  try {
    fs.writeFileSync(COOKIES_FILE, cookies.trim(), { mode: 0o600 });
    logger.info("YouTube cookies loaded — high-quality formats unlocked");
    return ["--cookies", COOKIES_FILE];
  } catch (err) {
    logger.warn({ err }, "Failed to write YouTube cookies file — continuing without cookies");
    return [];
  }
}

// Clean regular weight for headline text — matches reference style
const CAPTION_FONTS = [
  path.join(FONTS_DIR, "SpaceGrotesk.ttf"),
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
];

// --- Simple concurrency queue: max 2 simultaneous jobs ---
const MAX_CONCURRENT = 1;

// Stall window for CPU-bound ffmpeg re-encodes (composite + caption burn) on the phone.
// These have no hard timeout, so the stall timer is the only hang guard — but on the weak,
// memory-starved phone a healthy render can legitimately emit no progress for minutes
// (filtergraph init, first-frame decode of a 1080p60 source, transient memory thrash). The
// old 90s default was killing such renders prematurely. 15 min only trips on a truly dead
// process. See spawnProcess / the composite render.
// NOTE: every render-phase spawnProcess call passes timeoutMs=0 (no hard wall-clock cap) — a
// phone render can legitimately run for hours, so RENDER_STALL_MS is the ONLY guard against a
// genuinely dead process. Do NOT reintroduce a hard cap on a "render" call: it SIGKILLs slow-
// but-healthy renders mid-way (this is what killed clip #56 at the 300s mark).
const RENDER_STALL_MS = 900_000;
let activeJobs = 0;
const jobQueue: Array<() => void> = [];

function drainQueue() {
  while (activeJobs < MAX_CONCURRENT && jobQueue.length > 0) {
    const next = jobQueue.shift()!;
    activeJobs++;
    next();
  }
}

export function enqueueClipJob(fn: () => Promise<void>): void {
  jobQueue.push(() => {
    fn().finally(() => {
      activeJobs--;
      drainQueue();
    });
  });
  drainQueue();
}

/**
 * The in-memory job queue does not survive a server restart. Any clip left in
 * "pending" or "processing" was interrupted and will never resume on its own,
 * so it would otherwise stay in that state forever. On startup we mark those
 * rows as "error" with a clear message so the user can retry them.
 */
export async function reconcileInterruptedJobs(): Promise<void> {
  try {
    const interrupted = await db
      .update(clipsTable)
      .set({
        status: "error",
        progress: 0,
        errorMessage:
          "Processing was interrupted by a server restart. Click retry to run this clip again.",
      })
      .where(inArray(clipsTable.status, ["pending", "processing"]))
      .returning({ id: clipsTable.id });

    if (interrupted.length > 0) {
      logger.warn(
        { count: interrupted.length, ids: interrupted.map((c) => c.id) },
        "Reconciled interrupted clip jobs after restart",
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to reconcile interrupted clip jobs");
  }
}

export function getOutputDir(): string {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  return OUTPUT_DIR;
}

export function getOutputFilePath(filename: string): string {
  return path.join(getOutputDir(), filename);
}

export function getUploadsDir(): string {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
  return UPLOADS_DIR;
}

export function getUploadFilePath(filename: string): string {
  return path.join(getUploadsDir(), filename);
}

function findYtDlp(): string {
  const candidates = [
    "/home/runner/workspace/.pythonlibs/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "yt-dlp";
}

function findPython(): string {
  const candidates = [
    "/home/runner/workspace/.pythonlibs/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    "python3",
  ];
  for (const c of candidates) {
    if (c === "python3" || fs.existsSync(c)) return c;
  }
  return "python3";
}

// Path to the Python script that renders headline text (with emoji) to a PNG.
// tsx sets __dirname to the artifact root, not the source file dir, so derive workspace root
// by climbing until we find the scripts directory (or fall back to the known Replit path).
function findWorkspaceRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "scripts", "render_headline.py"))) return dir;
    dir = path.dirname(dir);
  }
  // Stable fallback for Termux
  return "/data/data/com.termux/files/home/myapp";
}
const RENDER_HEADLINE_SCRIPT = path.join(findWorkspaceRoot(), "scripts", "render_headline.py");
const DETECT_OVERLAP_SCRIPT = path.join(findWorkspaceRoot(), "scripts", "detect_watermark_overlap.py");

function findFont(): string {
  for (const f of CAPTION_FONTS) {
    if (fs.existsSync(f)) return f;
  }
  // Last resort: try Anton
  if (fs.existsSync(ANTON_FONT)) return ANTON_FONT;
  return CAPTION_FONTS[0]!;
}

export function timeToSeconds(ts: string): number {
  const parts = ts.split(":").map(Number);
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return parts[0]!;
}

/**
 * Normalises a YouTube URL so protocol/host casing differences don't trip up yt-dlp.
 * e.g. "Https://youtu.be/..." → "https://youtu.be/..."
 */
export function normalizeYoutubeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtube.com")) {
      if (parsed.pathname.startsWith("/live/")) {
        const videoId = parsed.pathname.replace("/live/", "").split("/")[0];
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
      if (parsed.pathname.startsWith("/shorts/")) {
        const videoId = parsed.pathname.replace("/shorts/", "").split("/")[0];
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }
    return parsed.toString();
  } catch {
    return url.replace(/^https?:\/\//i, (m) => m.toLowerCase());
  }
}

/**
 * Extracts a clean, human-readable error from a raw yt-dlp / ffmpeg command error.
 * Strips the "Command failed: ..." prefix and keeps only ERROR/WARNING lines.
 */
const NOISE_PATTERNS = [
  /No supported JavaScript runtime/,
  /js-runtimes RUNTIME/,
  /youtube\.com\/watch/,
];

function isNoiseLine(line: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(line));
}

/** Human-readable H:MM:SS (or M:SS) from a seconds count. */
export function formatHMS(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(sec).padStart(2, "0")}`;
}

/**
 * Up-front validation that the requested [startTime, endTime] window actually exists in the
 * source video. Fetches the video's real duration from yt-dlp (metadata only, no download) and
 * rejects a start time at/past the end — the "timestamp doesn't exist for this video" case that
 * otherwise only surfaces minutes later as a frozen/failed render. Best-effort: if the duration
 * can't be fetched (transient yt-dlp/network error) it returns ok:true and lets the
 * download-time short-download guard backstop it, rather than blocking clip creation.
 */
const durationCache = new Map<string, { dur: number; at: number }>();
const DURATION_CACHE_TTL_MS = 10 * 60_000;

export type SegmentCheckReason = "ok" | "start-past-end" | "end-past-end" | "unverified";

export async function validateSegmentWithinVideo(
  youtubeUrl: string,
  startTime: string,
  endTime: string
): Promise<{ ok: boolean; reason?: SegmentCheckReason; message?: string; videoDuration?: number }> {
  let videoDuration = 0;
  const cached = durationCache.get(youtubeUrl);
  if (cached && Date.now() - cached.at < DURATION_CACHE_TTL_MS) {
    // Reuse a recent lookup so batching several clips from the same video is instant (the
    // yt-dlp metadata fetch is slow on the phone — ~30s per call).
    videoDuration = cached.dur;
  } else {
    try {
      const { stdout } = await execFileAsync(
        findYtDlp(),
        ["--no-playlist", "--no-warnings", ...getCookiesArgs(), "--print", "%(duration)s", youtubeUrl],
        { timeout: 45_000 }
      );
      videoDuration = parseFloat(String(stdout).trim().split("\n")[0] ?? "") || 0;
      if (videoDuration > 0) durationCache.set(youtubeUrl, { dur: videoDuration, at: Date.now() });
    } catch {
      // Can't verify → don't BLOCK the enqueue (the download-time guard backstops), but flag
      // it as unverified so the UI never paints a confident "valid" it didn't actually check.
      return { ok: true, reason: "unverified", message: "Couldn't fetch this video's length right now — it'll be re-checked when the clip renders." };
    }
  }
  if (videoDuration <= 0) return { ok: true, reason: "unverified", message: "Couldn't read this video's length right now — it'll be re-checked when the clip renders." };

  const startSeconds = timeToSeconds(startTime);
  const endSeconds = timeToSeconds(endTime);
  if (startSeconds >= videoDuration) {
    return {
      ok: false,
      reason: "start-past-end",
      videoDuration,
      message: `That timestamp doesn't exist in this video. The video is only ${formatHMS(videoDuration)} long, but the clip starts at ${startTime}. Pick a start time within ${formatHMS(videoDuration)}.`,
    };
  }
  // End past the end still short-downloads (part of the window doesn't exist). Half-second
  // epsilon so an exactly-at-the-end cut isn't flagged (the render clamps that harmlessly).
  if (endSeconds > videoDuration + 0.5) {
    return {
      ok: false,
      reason: "end-past-end",
      videoDuration,
      message: `This clip runs to ${endTime}, but the video is only ${formatHMS(videoDuration)} long. Trim the end to within ${formatHMS(videoDuration)}.`,
    };
  }
  return { ok: true, reason: "ok", videoDuration };
}

/** Zero-padded HH:MM:SS from a seconds count (form fields require this exact shape). */
function secondsToHMS(total: number): string {
  const s = Math.max(0, Math.round(total));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, "0")).join(":");
}

const transcriptCache = new Map<string, { cues: { start: number; text: string }[]; at: number }>();

/** Parses WebVTT into timed cues. Strips inline karaoke tags; dedupes YouTube's rolling repeats. */
function parseVttCues(vtt: string): { start: number; text: string }[] {
  const cues: { start: number; text: string }[] = [];
  const lines = vtt.split(/\r?\n/);
  const timeRe = /(\d{1,2}:\d{2}:\d{2})[.,](\d{3})\s*-->/;
  let lastText = "";
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(timeRe);
    if (!m) continue;
    const start = timeToSeconds(m[1]!) + Number(m[2]) / 1000;
    const txt: string[] = [];
    for (let j = i + 1; j < lines.length && lines[j]!.trim() !== "" && !timeRe.test(lines[j]!); j++) {
      txt.push(lines[j]!.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim());
    }
    const text = txt.join(" ").replace(/\s+/g, " ").trim();
    if (!text || text === lastText) continue;
    lastText = text;
    cues.push({ start, text });
  }
  return cues;
}

/**
 * Fetches a video's English transcript (auto-captions) via yt-dlp and parses it into timed
 * cues, for deterministically auto-locating a moment whose Gemini timestamp is out of range.
 * NOT an AI call — plain keyword matching downstream. Best-effort: returns [] when the video
 * has no captions, and caches per-URL like durationCache.
 */
export async function fetchTranscriptCues(youtubeUrl: string): Promise<{ start: number; text: string }[]> {
  const cached = transcriptCache.get(youtubeUrl);
  if (cached && Date.now() - cached.at < DURATION_CACHE_TTL_MS) return cached.cues;
  const stem = path.join(os.tmpdir(), `t5sub_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const base = path.basename(stem);
  const dir = path.dirname(stem);
  let cues: { start: number; text: string }[] = [];
  try {
    await execFileAsync(
      findYtDlp(),
      ["--no-playlist", "--no-warnings", ...getCookiesArgs(),
       "--skip-download", "--write-auto-subs", "--write-subs",
       "--sub-langs", "en.*,en", "--sub-format", "vtt/best", "--convert-subs", "vtt",
       "-o", stem, youtubeUrl],
      { timeout: 60_000 }
    );
    const vtt = fs.readdirSync(dir).find((f) => f.startsWith(base) && f.endsWith(".vtt"));
    if (vtt) cues = parseVttCues(fs.readFileSync(path.join(dir, vtt), "utf8"));
  } catch {
    cues = [];
  } finally {
    try { for (const f of fs.readdirSync(dir)) if (f.startsWith(base)) fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
  }
  transcriptCache.set(youtubeUrl, { cues, at: Date.now() });
  return cues;
}

const LOCATE_STOPWORDS = new Set(
  ("the a an and or of to in on at is are was were be been being by for with from into out over as it its his her their our your my he she they we you i this that these those number one two three four five six seven eight nine ten most best top ever goes go into very really just about after before during while when where what which who how then than more much many big huge massive crazy craziest insane amazing incredible terrifying unbelievable")
    .split(" ")
);

/**
 * Locates a moment inside a transcript by weighted keyword overlap. Capitalized mid-phrase
 * tokens (driver/place names) weigh 3× — those are what actually pin a moment. Scores a ±1-cue
 * window (spoken words often land a beat off the visual). Returns the best window of
 * `requestedDur`, or null when nothing clears the confidence bar → caller uses the re-ask path.
 */
export function locateMomentInTranscript(
  cues: { start: number; text: string }[],
  headline: string,
  narration: string,
  requestedDur: number,
  videoDuration: number
): { startTime: string; endTime: string; confidence: number; evidence: string } | null {
  if (cues.length === 0) return null;
  // NAMES (drivers/places) disambiguate WHICH moment this is; TERMS are generic descriptors.
  // Names come from the NARRATION only — it's sentence-case prose, so any capitalized non-initial
  // word is a real proper noun (incl. surnames like "Kubica"). The HEADLINE is Title Case, so its
  // capitals mean nothing — take it as terms only, or "Pure First Lap Carnage" would look like a
  // pile of names and match the wrong clip (a compilation repeats "first lap" everywhere).
  const narrTokens = narration.replace(/^\s*Number\s+\w+\s*:/i, " ").match(/[A-Za-z][A-Za-z'-]{2,}/g) ?? [];
  const names = new Map<string, number>();
  narrTokens.forEach((tok, idx) => {
    const low = tok.toLowerCase();
    if (LOCATE_STOPWORDS.has(low)) return;
    if (idx > 0 && /^[A-Z]/.test(tok)) names.set(low, 3);
  });
  const terms = new Map<string, number>();
  for (const tok of [...(headline.match(/[A-Za-z][A-Za-z'-]{2,}/g) ?? []), ...narrTokens]) {
    const low = tok.toLowerCase();
    if (LOCATE_STOPWORDS.has(low) || names.has(low)) continue;
    terms.set(low, 1);
  }
  const total = [...names.values(), ...terms.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  // Whole-word matching (a keyword must be its own word, not a substring — otherwise "spa"
  // matches "Sparks" and "flip" matches "backflip", pinning the wrong cue).
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRes = [...names].map(([n, w]) => ({ re: new RegExp(`\\b${esc(n)}\\b`), w }));
  const termRes = [...terms].map(([t, w]) => ({ re: new RegExp(`\\b${esc(t)}\\b`), w }));

  // Full weight for a hit in THIS cue, partial credit for an adjacent one (rolling captions
  // split a moment across cues) — so the cue that actually contains the words wins the timestamp.
  const scoreCue = (i: number): { score: number; nameHit: boolean } => {
    const own = cues[i]!.text.toLowerCase();
    const neighbor = `${cues[i - 1]?.text ?? ""} ${cues[i + 1]?.text ?? ""}`.toLowerCase();
    let score = 0, nameHit = false;
    for (const { re, w } of nameRes) {
      if (re.test(own)) { score += w; nameHit = true; }
      else if (re.test(neighbor)) { score += w * 0.4; nameHit = true; }
    }
    for (const { re, w } of termRes) {
      if (re.test(own)) score += w;
      else if (re.test(neighbor)) score += w * 0.4;
    }
    return { score, nameHit };
  };

  // When the moment names a driver/place, only consider cues that actually mention it; otherwise
  // fall back to best keyword coverage with a higher bar (so a nameless generic match isn't trusted).
  let best = { score: 0, start: 0, evidence: "" };
  for (let i = 0; i < cues.length; i++) {
    const { score, nameHit } = scoreCue(i);
    const eligible = names.size > 0 ? nameHit : true;
    if (eligible && score > best.score) best = { score, start: cues[i]!.start, evidence: cues[i]!.text };
  }
  const confidence = best.score / total;
  const bar = names.size > 0 ? 0 : 0.6;
  if (best.score <= 0 || confidence <= bar) return null;

  const maxStart = Math.max(0, videoDuration - requestedDur);
  const start = Math.max(0, Math.min(best.start - 1.5, maxStart));
  return {
    startTime: secondsToHMS(start),
    endTime: secondsToHMS(Math.min(videoDuration, start + requestedDur)),
    confidence: Math.round(Math.min(1, confidence) * 100) / 100,
    evidence: best.evidence.slice(0, 120),
  };
}

export function parseProcessingError(raw: string): string {
  // Detect process kill / stall / timeout before parsing stderr content. spawnProcess
  // embeds a phase-accurate human message after a "killed|" marker — surface that verbatim
  // so a killed RENDER is never mislabeled as a download timeout (the old bug: a composite
  // render killed by the stall timer reported "Download timed out — try a shorter segment",
  // even though the download had already succeeded).
  if (/killed|timed out|stalled|SIGTERM|SIGKILL/i.test(raw) && !raw.includes("ERROR:")) {
    const marked = raw.split("killed|")[1];
    if (marked) {
      const msg = marked.split("\n")[0]!.trim();
      if (msg) return msg.slice(0, 300);
    }
    return "The process was stopped — it stalled or ran out of memory. Retry the clip (closing other apps frees RAM).";
  }

  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

  // Look for explicit ERROR lines first (most informative)
  const errorLines = lines.filter((l) => l.startsWith("ERROR:"));
  if (errorLines.length > 0) {
    return errorLines
      .map((l) => l.replace(/^ERROR:\s*\[youtube[^\]]*\]\s*[^:]+:\s*/, "").replace(/^ERROR:\s*/, ""))
      .join(" | ")
      .slice(0, 400);
  }

  // Fall back to meaningful WARNING lines (skip known noise)
  const warnLines = lines.filter(
    (l) => l.startsWith("WARNING:") && !isNoiseLine(l)
  );
  if (warnLines.length > 0) {
    return warnLines.map((l) => l.replace(/^WARNING:\s*/, "")).join(" | ").slice(0, 400);
  }

  // Last resort: strip "Command failed: <command>" prefix, skip noise lines
  const withoutCmd = raw.replace(/^Command failed:[^\n]+\n?/, "").trim();
  const meaningfulLines = withoutCmd.split("\n").map((l) => l.trim()).filter((l) => l && !isNoiseLine(l));
  const cleaned = meaningfulLines.join(" | ").slice(0, 300);
  return cleaned || "Download failed — check the URL and timestamps.";
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\u2019")
    .replace(/:/g, "\\\\:")
    .replace(/\[/g, "\\\\[")
    .replace(/\]/g, "\\\\]")
    .replace(/,/g, "\\\\,")
    .replace(/;/g, "\\\\;")
    .replace(/\n/g, " ");
}

function wrapText(text: string, maxChars = 38): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
    } else if ((current + " " + word).length <= maxChars) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Creates a throttled progress updater for a clip. Writes at most once per second
 * to avoid hammering the DB during long ffmpeg encodes.
 */
function makeProgressUpdater(clipId: number) {
  let lastTime = 0;
  // Monotonic guard: progress only ever moves forward within a clip's render. Without this,
  // a cloud attempt that reaches ~30% then falls back to a LOCAL render (which restarts its
  // own counter at ~2%) made the bar visibly REWIND (the reported "7% → 2% went backwards").
  let lastPct = -1;
  return async (pct: number, force = false) => {
    if (!clipId) return;
    const clamped = Math.min(100, Math.max(0, Math.round(pct)));
    if (clamped < lastPct) return; // never rewind
    const now = Date.now();
    if (!force && now - lastTime < 1000) return;
    lastTime = now;
    lastPct = clamped;
    try {
      await db
        .update(clipsTable)
        .set({ progress: clamped })
        .where(eq(clipsTable.id, clipId));
    } catch {
      // Non-fatal — progress is best-effort
    }
  };
}

/**
 * Spawns a child process, accumulates stderr for error reporting, and calls
 * onLine for every line of output (both stdout and stderr) for progress parsing.
 *
 * stallTimeoutMs: if no output is received for this long, the process is killed.
 * This catches silently hung downloads where the TCP connection stalls mid-transfer
 * and ffmpeg waits forever for bytes that never arrive.
 */
function spawnProcess(
  cmd: string,
  args: string[],
  timeoutMs: number,
  onLine?: (line: string) => void,
  stallTimeoutMs = 90_000,
  // phase drives the human-readable stall/timeout message. A killed RENDER must never be
  // reported as a "download timed out" (the download already succeeded by then).
  phase: "download" | "render" = "download"
): Promise<void> {
  return new Promise((resolve, reject) => {
    // detached: true puts yt-dlp in its own process group so that killing the group
    // also kills any grandchild ffmpeg processes spawned by yt-dlp. Without this,
    // killing yt-dlp leaves internal ffmpeg running as an orphan indefinitely.
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stderrBuf = "";
    let done = false;

    // Phase-accurate messages (surfaced to the user by parseProcessingError). The marker
    // text after "killed|" is what the user sees, so it must describe the real failure.
    const stallMsg =
      phase === "render"
        ? `Rendering stalled — no progress for ${stallTimeoutMs / 1000}s. The phone likely ran low on memory. Retry the clip (closing other apps frees RAM).`
        : `Download stalled — no data received for ${stallTimeoutMs / 1000}s. The video may be too long or the connection dropped. Retry the clip.`;
    const timeoutMsg =
      phase === "render"
        ? `Rendering timed out after ${timeoutMs / 1000}s. Retry the clip.`
        : `Download timed out after ${timeoutMs / 1000}s. Try a shorter segment or retry.`;

    function fail(msg: string) {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      clearTimeout(stallTimer);
      // Kill the entire process group (negative PID) to take down yt-dlp + its ffmpeg children
      try { process.kill(-proc.pid!, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
      reject(new Error(msg));
    }

    // Stall timer: reset every time data arrives; fires if nothing comes for stallTimeoutMs
    let stallTimer: ReturnType<typeof setTimeout>;
    function resetStall() {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => fail(`killed|${stallMsg}\n${stderrBuf}`),
        stallTimeoutMs
      );
    }
    resetStall();

    // Hard upper-bound timeout. timeoutMs <= 0 disables it entirely, leaving only
    // the stall timer as the safety net — used for CPU-bound ffmpeg renders that can
    // legitimately run very long on slow hardware (the phone) but still emit progress
    // output regularly, so a genuine hang (no output for stallTimeoutMs) is still caught.
    const hardTimer =
      timeoutMs > 0
        ? setTimeout(
            () => fail(`killed|${timeoutMsg}\n${stderrBuf}`),
            timeoutMs
          )
        : undefined;

    function handleData(chunk: Buffer, isStderr: boolean) {
      resetStall();
      const text = chunk.toString();
      if (isStderr) stderrBuf += text;
      if (onLine) {
        // yt-dlp progress lines end with \r; split on both so they fire the callback.
        for (const line of text.split(/\r?\n|\r/)) {
          if (line.trim()) onLine(line);
        }
      }
    }

    proc.stdout.on("data", (c: Buffer) => handleData(c, false));
    proc.stderr.on("data", (c: Buffer) => handleData(c, true));

    proc.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      clearTimeout(stallTimer);
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(stderrBuf || `Process exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      clearTimeout(stallTimer);
      reject(err);
    });
  });
}

/**
 * Builds the base yt-dlp arg list shared by all download attempts.
 */
function buildYtDlpArgs(
  section: string,
  format: string,
  outTemplate: string,
  youtubeUrl: string,
  cookiesArgs: string[],
  extraArgs: string[] = []
): string[] {
  return [
    "--no-playlist",
    "--remote-components", "ejs:github",
    "--download-sections", section,
    // NOTE: --force-keyframes-at-cuts is intentionally omitted.
    // On live recordings it spawns an internal ffmpeg that must seek through the entire
    // CDN stream to reach the cut point, hanging indefinitely on long videos.
    "--format", format,
    "--merge-output-format", "mp4",
    ...cookiesArgs,
    ...extraArgs,
    "-o", outTemplate,
    "--no-part",
    "--progress",
    "--newline",
    "--socket-timeout", "30",
    // Finite retries: under a sustained YouTube 429 these MUST terminate. Previously
    // "--fragment-retries inf" made yt-dlp retry the same fragment forever, keeping the
    // process alive (and emitting output that reset the stall timer), so the job sat in
    // "processing" for up to ~45 min and blocked the single-slot queue behind it.
    "--retries", "3",
    "--fragment-retries", "3",
    // Pace requests to avoid tripping YouTube's per-IP rate limiter in the first place.
    "--sleep-requests", "1.5",
    youtubeUrl,
  ];
}

/**
 * Match Story 2.0 (scout): download a WHOLE social clip (Reddit/X/Instagram/Facebook) by its
 * post URL. Unlike downloadSegment (YouTube sections, HD-floored, HLS/DASH juggling) social
 * clips are already short, so we just pull the best <=1080p muxed file with yt-dlp's per-site
 * extractor. `cookiesFile` is for the platforms that need a logged-in session (X/IG/FB).
 * Returns the output path on success, or throws.
 */
export async function downloadSocialClip(url: string, outPath: string, cookiesFile?: string): Promise<string> {
  const ytDlp = findYtDlp();
  const args = [
    "--no-playlist", "--no-warnings", "--no-part",
    // Prefer a REAL HD variant (720-1080) before settling for whatever exists. The old selector
    // only capped the ceiling, so a post with a 360p variant listed first came back soft — that
    // was a source of the blurry B-roll. The trailing un-floored fallbacks stay so a genuinely
    // SD-only clip still downloads; buildBeatsFromUrls' MIN_BEAT_SHORT_SIDE gate is what
    // actually decides whether it's sharp enough to use.
    "-f", [
      "bv*[height<=1080][height>=720]+ba",
      "b[height<=1080][height>=720]",
      "bv*[height<=1080]+ba",
      "b[height<=1080]",
      "b",
    ].join("/"),
    "--merge-output-format", "mp4",
    "-o", outPath,
  ];
  if (cookiesFile && fs.existsSync(cookiesFile)) args.push("--cookies", cookiesFile);
  else args.push(...getCookiesArgs());
  args.push(url);
  // 6-min hard cap, 90s stall guard — social downloads are small; a longer hang means a wall.
  await spawnProcess(ytDlp, args, 360_000, () => {}, 90_000, "download");
  if (!fs.existsSync(outPath)) throw new Error("Download produced no file");
  return outPath;
}

/**
 * Match Story 2.0 (scout): download a direct HLS/DASH manifest URL (e.g. Reddit's v.redd.it
 * CDN playlist) straight with ffmpeg — no yt-dlp, so it avoids Reddit's IP-blocked API. The
 * HLS variant carries audio; we stream-copy to mp4.
 */
export async function downloadHlsClip(url: string, outPath: string): Promise<string> {
  await spawnProcess("ffmpeg", [
    "-y", "-i", url, "-c", "copy", "-movflags", "+faststart", outPath,
  ], 360_000, () => {}, 90_000, "download");
  if (!fs.existsSync(outPath)) throw new Error("HLS download produced no file");
  return outPath;
}

/**
 * Downloads the exact time segment from YouTube using yt-dlp --download-sections.
 *
 * Strategy (all attempts are 720p+; we NEVER downgrade to 360p):
 *   1. HLS 1080p (archived live streams).
 *   2. DASH 1080p via native downloader + concurrent fragments.
 *      --downloader native makes yt-dlp download each DASH segment individually from the
 *      manifest, then ffmpeg muxes from local files. This avoids yt-dlp's internal ffmpeg
 *      seeking sequentially through the full CDN stream (which hangs on archived live recordings
 *      because it has to read through all content before the timestamp first).
 *      --concurrent-fragments 4 downloads up to 4 segments in parallel for faster throughput.
 *   3. 720p DASH via native downloader (same approach, smaller file).
 *   4. Cookie-authed web client, 720p+ floor (last resort).
 *
 * Quality guarantee: a hard MIN_VIDEO_HEIGHT (720p) post-download check rejects any sub-720p
 * result, and YouTube 429 throttling triggers a bounded backoff-retry of the SAME HD format
 * rather than a silent drop to 360p. If no HD stream is obtainable, the job fails (retryable)
 * instead of producing a low-quality clip.
 *
 * Returns the path to the downloaded temp file.
 */
async function downloadSegment(
  ytDlp: string,
  youtubeUrl: string,
  startTime: string,
  endTime: string,
  tmpId: string,
  onProgress: (pct: number) => void
): Promise<string> {
  const tmpDir = os.tmpdir();
  const section = `*${startTime}-${endTime}`;
  const cookiesArgs = getCookiesArgs();

  // Native downloader args: download DASH segments individually (no full-stream seek),
  // with 4 concurrent connections for faster throughput.
  const nativeArgs = ["--downloader", "native", "--concurrent-fragments", "2", "--remote-components", "ejs:github"];

  const attempts: Array<{ format: string; label: string; stallMs: number; hardMs: number; extraArgs?: string[] }> = [
    {
      // Property-based HLS selector (NOT bare itags): YouTube now splits HLS streams by audio
      // language (301-0/301-1, 300-0/300-1, …), so bare "301"/"300" no longer match a single
      // format and yt-dlp errors "Requested format is not available". This selector matches
      // whichever 720-1080p HLS variant exists regardless of itag/language split. HLS streams are
      // muxed (single file, no ffmpeg merge), so they sidestep the merge failures DASH can hit.
      // 720p floor is enforced in the selector and re-checked post-download.
      format: "best[height>=720][height<=1080][protocol^=m3u8]/best[height>=720][protocol^=m3u8]",
      label: "HLS m3u8 (live stream)",
      stallMs: 300_000,
      hardMs: 900_000,
      extraArgs: ["--extractor-args", "youtube:player_client=android_vr,web"],
    },
    {
      format: "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080][ext=mp4]+bestaudio/bestvideo[height<=1080]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio",
      label: "DASH 1080p (native)",
      stallMs: 300_000,
      hardMs: 900_000,
      extraArgs: ["--downloader", "native", "--concurrent-fragments", "2", "--remote-components", "ejs:github", "--extractor-args", "youtube:player_client=android_vr,web"],
    },
    {
      format: "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720][ext=mp4]+bestaudio/bestvideo[height<=720]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio",
      label: "DASH 720p (native)",
      stallMs: 300_000,
      hardMs: 600_000,
      extraArgs: ["--downloader", "native", "--concurrent-fragments", "2", "--remote-components", "ejs:github", "--extractor-args", "youtube:player_client=android_vr,web"],
    },
    {
      // HD-floored last resort: cookie-authed web client (different from the android_vr
      // attempts above), 720p minimum. We deliberately DO NOT fall back to 360p (fmt 18)
      // or bare "best" — a 360p clip is worse than failing and retrying once the throttle
      // clears. The post-download height check below enforces this floor for real.
      format: "bestvideo[height>=720][height<=1080]+bestaudio/22/best[height>=720]",
      label: "HD fallback (720p+ floor, cookies)",
      stallMs: 300_000,
      hardMs: 300_000,
      extraArgs: ["--downloader", "native", "--concurrent-fragments", "2", "--remote-components", "ejs:github"],
    },
  ]

  // Quality guarantee: never composite a source below this height. Under a YouTube 429
  // throttle, only the tiny 360p progressive stream slips through, so a low-res result is
  // itself a throttle symptom — we reject it (and retry HD) rather than ship a 360p clip.
  const MIN_VIDEO_HEIGHT = 720;
  // Bounded, shared backoff budget across all attempts so a persistent throttle errors out
  // in a few minutes (retryable) instead of hanging — and never silently downgrades quality.
  const RL_MAX_TOTAL = 3;
  let rlRetriesTotal = 0;
  // Whole-job wall-clock cap: a single download must never occupy the single-slot queue
  // (MAX_CONCURRENT = 1) for tens of minutes. Across ALL attempts combined, give up after
  // this budget and fail (retryable) so clips queued behind it can proceed.
  const DOWNLOAD_BUDGET_MS = 12 * 60_000;
  const overallDeadline = Date.now() + DOWNLOAD_BUDGET_MS;
  const isRateLimited = (m: string) => /\b429\b/.test(m) || /too many requests/i.test(m);
  const probeHeight = async (file: string): Promise<number> => {
    try {
      const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", file], { timeout: 30_000 });
      return parseInt(String(stdout).trim(), 10) || 0;
    } catch { return 0; }
  };

  let lastError: Error = new Error("no attempts made");

  for (const [i, attempt] of attempts.entries()) {
    const attemptId = i === 0 ? tmpId : `${tmpId}_fb${i}`;
    const outTemplate = path.join(tmpDir, `clip_raw_${attemptId}.%(ext)s`);

    // Retry the SAME (HD) attempt on transient rate-limiting before stepping down.
    for (;;) {
      // Enforce the whole-job wall-clock cap on every (initial + backoff) iteration so a
      // persistent 429 can never keep the job in "processing" indefinitely.
      if (Date.now() > overallDeadline) {
        throw new Error("YouTube download exceeded its time budget (likely 429 throttling) and no HD (720p+) stream came through. Quality floor held (no 360p). Wait a few minutes and retry this clip.");
      }
      logger.info(
        { youtubeUrl, startTime, endTime, section, format: attempt.format, attempt: i + 1 },
        "Downloading segment via yt-dlp"
      );

      try {
        await spawnProcess(
          ytDlp,
          buildYtDlpArgs(section, attempt.format, outTemplate, youtubeUrl, (attempt.extraArgs ?? []).join(" ").includes("android_vr") ? [] : cookiesArgs, attempt.extraArgs ?? []),
          // Cap this attempt's hard timeout to whatever remains of the whole-job budget, so
          // the four attempts can never sum to ~45 min. Floor at 30s so a near-exhausted
          // budget still gives a real (if short) final try before the deadline check trips.
          Math.max(30_000, Math.min(attempt.hardMs, overallDeadline - Date.now())),
          (line) => {
            const m = line.match(/\[download\]\s+(\d+\.?\d*)%/);
            if (m) {
              const ytPct = parseFloat(m[1]!);
              // Map yt-dlp's 0-100% → overall progress 2-48%
              onProgress(ytPct * 0.45);
            }
          },
          attempt.stallMs
        );

        // Locate the output file
        const candidates = ["mp4", "mkv", "webm"].map((ext) => path.join(tmpDir, `clip_raw_${attemptId}.${ext}`));
        let outFile = candidates.find((c) => fs.existsSync(c)) ?? null;
        if (!outFile) {
          const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(`clip_raw_${attemptId}`));
          if (files.length > 0) outFile = path.join(tmpDir, files[0]!);
        }
        if (!outFile) throw new Error("yt-dlp finished but no output file found");

        // Hard quality floor — reject and retry rather than composite sub-720p.
        const h = await probeHeight(outFile);
        if (h && h < MIN_VIDEO_HEIGHT) {
          try { fs.unlinkSync(outFile); } catch { /* ignore */ }
          throw new Error(`downloaded video is ${h}p, below the ${MIN_VIDEO_HEIGHT}p quality floor`);
        }
        return outFile;
      } catch (err) {
        lastError = err as Error;
        const msg = lastError.message;
        const belowFloor = msg.includes("quality floor");

        // Transient 429 (or a throttle-induced low-res result): back off and retry the
        // SAME HD format, preserving resolution. Bounded by a shared budget.
        if ((isRateLimited(msg) || belowFloor) && rlRetriesTotal < RL_MAX_TOTAL) {
          rlRetriesTotal++;
          const backoffMs = 15_000 * rlRetriesTotal; // 15s, 30s, 45s
          logger.warn(
            { attempt: attempt.label, rlRetry: rlRetriesTotal, backoffMs, error: msg.slice(0, 150) },
            "YouTube rate-limited (429) / low-res — backing off, then retrying the same HD format"
          );
          await new Promise((r) => setTimeout(r, backoffMs));
          continue; // retry SAME attempt
        }

        // Any other failure — a format-not-available, an ffmpeg/mux error (e.g. "ffmpeg exited
        // with code 8" on a fragile 1080p60 DASH section), a network drop, a stall — is NOT fatal
        // on its own. Step to the NEXT download strategy; we only give up once the LAST attempt has
        // failed. This guarantees one flaky format can never sink the whole download. (Previously a
        // non-whitelisted error such as the ffmpeg mux failure aborted the chain before ever trying
        // the lower-bitrate 720p DASH / HD-fallback attempts, which usually succeed.)
        if (i === attempts.length - 1) {
          // All HD strategies exhausted.
          if (isRateLimited(msg) || belowFloor) {
            throw new Error("YouTube is rate-limiting downloads (HTTP 429) and no HD (720p+) stream came through. Quality floor held (no 360p). Wait a few minutes and retry this clip.");
          }
          throw lastError;
        }

        logger.warn(
          { attempt: attempt.label, error: msg.slice(0, 200) },
          `Download failed on ${attempt.label}; stepping to next strategy: ${attempts[i + 1]!.label}`
        );
        break; // step to the next (still HD) attempt
      }
    }
  }

  throw lastError;
}

/**
 * extract_segment (YouTube): download EXACTLY [startTime,endTime] via the HD-floored downloadSegment
 * ladder above, then remux the result into `outPath` as a faststart mp4. Used by the MCP connector so
 * a montage beat can be the precise moment cut out of a long official highlight — not the whole video.
 * (downloadSegment already downloads only the section, so no second trim is needed here.)
 */
export async function downloadYouTubeSegment(url: string, startTime: string, endTime: string, outPath: string): Promise<string> {
  const ytDlp = findYtDlp();
  const tmpId = `mcpseg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const raw = await downloadSegment(ytDlp, url, startTime, endTime, tmpId, () => {});
  try {
    // Remux (no re-encode) into the requested mp4 path — downloadSegment may hand back mkv/webm.
    await spawnProcess("ffmpeg", ["-y", "-i", raw, "-c", "copy", "-movflags", "+faststart", outPath], 300_000, () => {}, 90_000, "download");
    if (!fs.existsSync(outPath)) throw new Error("segment remux produced no file");
    return outPath;
  } finally {
    try { fs.existsSync(raw) && fs.unlinkSync(raw); } catch { /* */ }
  }
}

// The six AI auto-zoom effects. Gemini picks one per moment; the ffmpeg expressions
// for each are built in processClip (all sharp lanczos scale+crop — never zoompan).
type ZoomType = "punch" | "whip" | "cut" | "pushin" | "pullout" | "kenburns";

interface ZoomEvent { sec: number; type: ZoomType; }

// Normalised (alnum-only, lowercase) keyword -> canonical type, so we tolerate the
// variants Gemini may emit ("push-in", "ken burns", "zoom out", "snap", ...).
const ZOOM_ALIASES: Record<string, ZoomType> = {
  punch: "punch", punchin: "punch", punchzoom: "punch",
  whip: "whip", snap: "whip", whipzoom: "whip", snapzoom: "whip",
  cut: "cut", hardcut: "cut", jumpcut: "cut", cutzoom: "cut",
  pushin: "pushin", push: "pushin", zoomin: "pushin", pushzoom: "pushin",
  pullout: "pullout", pull: "pullout", zoomout: "pullout", reveal: "pullout", pullback: "pullout",
  kenburns: "kenburns", ken: "kenburns", burns: "kenburns", pan: "kenburns",
};

/**
 * Parses AI auto-zoom events the user pastes from Gemini. Each event is a SECOND plus
 * an optional zoom TYPE, e.g. "3 punch, 9 pushin, 16 kenburns". Tolerates bare seconds
 * (defaults to punch, back-compatible), mm:ss timestamps, and comma/semicolon/newline
 * separators. Clamps inside the clip, sorts, enforces a 1.2s min gap so zooms can't
 * stack and over-crop, caps at 10.
 */
function parseZoomEvents(raw: string, duration: number): ZoomEvent[] {
  if (!raw || !raw.trim()) return [];
  const chunks = raw.split(/[,;\n]+/).map((c) => c.trim()).filter(Boolean);
  const events: ZoomEvent[] = [];
  for (const chunk of chunks) {
    let sec: number | null = null;
    let type: ZoomType = "punch";
    for (const tok of chunk.split(/\s+/).filter(Boolean)) {
      const low = tok.toLowerCase().replace(/[^a-z0-9:.]/g, "");
      if (!low) continue;
      if (ZOOM_ALIASES[low]) { type = ZOOM_ALIASES[low]; continue; }
      if (sec !== null) continue;
      let s: number;
      if (low.includes(":")) {
        const parts = low.split(":").map(Number);
        if (parts.some((n) => Number.isNaN(n))) continue;
        s = parts.reduce((a, n) => a * 60 + n, 0);
      } else {
        s = Number(low);
      }
      if (Number.isFinite(s)) sec = s;
    }
    if (sec === null || !Number.isFinite(sec)) continue;
    if (sec < 0.5 || sec > duration - 0.3) continue;
    events.push({ sec: Math.round(sec * 10) / 10, type });
  }
  events.sort((a, b) => a.sec - b.sec);
  const out: ZoomEvent[] = [];
  for (const e of events) {
    if (out.length && e.sec - out[out.length - 1].sec < 1.2) continue;
    out.push(e);
  }
  return out.slice(0, 10);
}

/** Evenly-spaced punches (~every 5s) when auto-zoom is on but no AI events were given. */
function defaultZoomEvents(duration: number): ZoomEvent[] {
  const out: ZoomEvent[] = [];
  for (let t = 5; t < duration - 0.5; t += 5) out.push({ sec: t, type: "punch" });
  return out.slice(0, 10);
}

interface NarrationLine { sec: number; text: string; }

/**
 * Parses the full-narration script the user pastes back from Gemini (the Pro
 * "narration mode" bridge). Each line is a START time plus "|" plus the sentence
 * to speak, e.g.  "2 | Nobody saw this coming."  Mirrors parseZoomEvents: tolerates
 * bare seconds or mm:ss, clamps the start inside the clip (and before the 2s outro
 * card so narration never lands on the SUBSCRIBE screen), sorts, enforces a small
 * min start-gap so two lines can't begin on top of each other, and caps the count
 * (a length / OOM guard — each line is a separate Piper synth + amix input).
 */
function parseNarrationLines(raw: string, duration: number, outroEnabled: boolean, maxLines = 8): NarrationLine[] {
  if (!raw || !raw.trim()) return [];
  // Latest a line may START. With the outro card on, keep it clear of the last 2s.
  const latestStart = (outroEnabled ? duration - 2.2 : duration - 0.5);
  const parsed: NarrationLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const bar = line.indexOf("|");
    if (bar === -1) continue;
    const text = line.slice(bar + 1).trim().replace(/\s+/g, " ").slice(0, 180);
    if (!text) continue;
    const tok = line.slice(0, bar).toLowerCase().replace(/[^0-9:.]/g, "");
    if (!tok) continue;
    let sec: number;
    if (tok.includes(":")) {
      const parts = tok.split(":").map(Number);
      if (parts.some((n) => Number.isNaN(n))) continue;
      sec = parts.reduce((a, n) => a * 60 + n, 0);
    } else {
      sec = Number(tok);
    }
    if (!Number.isFinite(sec)) continue;
    if (sec < 0.3) sec = 0.3;
    if (sec > latestStart) continue; // a line that can't start before the clip/outro ends is dropped
    parsed.push({ sec: Math.round(sec * 10) / 10, text });
  }
  parsed.sort((a, b) => a.sec - b.sec);
  const spaced: NarrationLine[] = [];
  for (const e of parsed) {
    if (spaced.length && e.sec - spaced[spaced.length - 1]!.sec < 0.8) continue;
    spaced.push(e);
  }
  return spaced.slice(0, Math.max(1, maxLines));
}

// Pro-only: which Piper voice + speaking pace a job's voiceover uses. Threaded from the
// clip row (voiceoverVoice / voiceoverSpeed) down to every Piper call. Both optional —
// blank fields fall back to the smart per-mode default below.
export type VoiceOpts = { voice?: string; speed?: string };

// Piper voices installed on the phone (~/piper/*.onnx). An unknown name is ignored and
// the per-mode default is used instead, so a stale/typo'd voice never breaks a render.
const KNOWN_VOICES = new Set([
  "en_GB-alan-medium",
  "en_US-joe-medium",
  "en_US-norman-medium",
  "en_GB-northern_english_male-medium",
  "en_US-hfc_male-medium",
  "en_US-ryan-medium",
  "en_US-lessac-medium",
]);

/**
 * Resolves the Piper voice for a job. An explicit, installed voice wins; otherwise the
 * default matches each mode's character (and the picker's defaults): Top 5 → Joe (deep,
 * "epic countdown"), Match Story 2.0 / Scout → HFC male (clean, neutral US narrator),
 * base Story / full-narration → Alan (warm documentary narrator), a single-clip intro
 * hook → Joe.
 */
function resolveVoice(voice: string | undefined, kind: "top5" | "story" | "script" | "hook" | "matchstory"): string {
  const v = (voice ?? "").trim();
  if (v && KNOWN_VOICES.has(v)) return v;
  if (kind === "matchstory") return "en_US-ryan-medium"; // Story Mode 2.0 / Scout default (warm voice)
  if (kind === "story" || kind === "script") return "en_GB-alan-medium";
  return "en_US-joe-medium"; // top5 + single-clip hook
}

/** Piper length_scale as a clean string: normal = "1.0", higher = slower. Clamped. */
function resolveSpeed(speed: string | undefined): string {
  const s = parseFloat(speed ?? "");
  if (Number.isFinite(s) && s >= 0.7 && s <= 1.8) return s.toFixed(2);
  return "1.0";
}

/**
 * Speaks `text` to `outWav` via the local Piper TTS script (same script the intro
 * hook uses), in the given voice + pace. Resolves true only if the WAV was actually
 * produced. Non-throwing — a missing script / failed synth resolves false so the caller
 * can skip that line.
 */
async function generateNarrationWav(text: string, outWav: string, voice: string, speed: string): Promise<boolean> {
  const voiceScript = path.join(os.homedir(), "myapp/scripts/generate_voiceover.sh");
  if (!fs.existsSync(voiceScript)) return false;
  // THE choke point: every narration line in every mode (story / matchstory / top5 / hook)
  // reaches Piper through here, so respelling here fixes pronunciation everywhere at once.
  // Captions are built from a separate string and are NOT affected — see PRONUNCIATION_MAP.
  const spoken = applyPronunciation(text);
  await new Promise<void>((resolve) => {
    const v = spawn("bash", [voiceScript, spoken, outWav, voice, speed], { timeout: 120_000 });
    v.on("close", () => resolve());
    v.on("error", () => resolve());
  });
  return fs.existsSync(outWav);
}

/**
 * yt-dlp `--download-sections` can emit a segment whose frames carry NO presentation
 * timestamps — seen on sections cut from deep inside long livestream VODs (e.g. a clip
 * 3 hours into a 3h+ stream, AV1 or H.264 alike). ffmpeg then decodes 0 frames through
 * the composite filtergraph and the render "stalls" at frame 0 forever (which the stall
 * timer eventually kills). We detect that here (the first video frame has no pts) and
 * only then rebuild a clean file — normal clips are untouched.
 */
/** Actual playable duration (seconds) of a media file, or 0 if it can't be probed. */
async function probeContentDuration(file: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
    ], { timeout: 30_000 });
    return parseFloat(String(stdout).trim()) || 0;
  } catch {
    return 0;
  }
}

async function segmentHasValidTimestamps(file: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1",
      "-show_entries", "frame=pts_time", "-of", "csv=p=0", file,
    ], { timeout: 30_000 });
    const first = String(stdout).trim().split("\n")[0]?.trim() ?? "";
    return first !== "" && first.toUpperCase() !== "N/A";
  } catch {
    return true; // If we can't tell, don't force a needless re-encode.
  }
}

async function probeFps(file: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=avg_frame_rate", "-of", "csv=p=0", file,
    ], { timeout: 30_000 });
    const [num, den] = String(stdout).trim().split("/").map((n) => parseInt(n, 10));
    if (num && den) return num / den;
    if (num) return num;
  } catch { /* fall through */ }
  return 30;
}

async function segmentHasAudio(file: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
      "-of", "csv=p=0", file,
    ], { timeout: 15_000 });
    return String(stdout).trim().length > 0;
  } catch { return false; }
}

/**
 * Rebuilds timestamps for a pts-less segment (see segmentHasValidTimestamps). Two passes:
 * (1) a lossless `-c copy` remux with +genpts makes the pts-less packets decodable (a plain
 * decode of the raw file yields 0 frames); (2) a re-encode that reassigns pts from the frame
 * index (setpts=N/fps/TB) at the source frame rate yields a clean, correct-duration CFR file.
 * Quality-preserving (crf 12 intermediate; the composite re-encodes at crf 14 anyway).
 * Returns the normalized path and deletes the original + the intermediate remux.
 */
async function normalizeSegmentTimestamps(file: string, tmpId: string): Promise<string> {
  const tmpDir = os.tmpdir();
  const fps = await probeFps(file);
  const hasAudio = await segmentHasAudio(file);
  const remuxPath = path.join(tmpDir, `clip_remux_${tmpId}.mp4`);
  const cleanPath = path.join(tmpDir, `clip_norm_${tmpId}.mp4`);

  logger.info({ file, fps, hasAudio }, "Segment has no frame timestamps — normalizing before composite");

  // Pass 1: genpts stream-copy remux (lossless) so the pts-less packets become decodable.
  await spawnProcess("ffmpeg", [
    "-y", "-fflags", "+genpts", "-i", file, "-c", "copy", remuxPath,
  ], 0, undefined, RENDER_STALL_MS, "render");

  // Pass 2: re-encode rebuilding pts from the frame/sample index → correct duration & pacing.
  const args = [
    "-y", "-i", remuxPath,
    "-vf", `setpts=N/${fps}/TB`, "-r", String(fps), "-fps_mode", "cfr",
    ...(hasAudio ? ["-af", "asetpts=N/SR/TB"] : ["-an"]),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p",
    ...(hasAudio ? ["-c:a", "aac", "-b:a", "256k"] : []),
    "-movflags", "+faststart", cleanPath,
  ];
  await spawnProcess("ffmpeg", args, 0, undefined, RENDER_STALL_MS, "render");

  try { fs.unlinkSync(remuxPath); } catch { /* ignore */ }
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  logger.info({ cleanPath }, "Segment normalized");
  return cleanPath;
}

// ── Cloud render offload ──────────────────────────────────────────────────────
// When CLOUD_RENDER_URL is set, the heavy composite/captions/voiceover can run on a
// remote worker (fast box, no OOM — see the Codespace worker in src/worker.ts). The
// phone still DOWNLOADS on its home IP (yt-dlp is never run on the cloud), then ships
// the already-cut segment up. Any failure returns false → the caller renders locally.
async function cloudHealthOk(base: string, timeoutMs = 3500): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const u = new URL("/health", base);
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.get(u, { timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.on("error", () => resolve(false));
    } catch { resolve(false); }
  });
}

async function offloadToCloud(
  inputPath: string,
  outPath: string,
  params: Record<string, unknown>,
  onProgress: (p: number) => void = () => {},
): Promise<boolean> {
  const base = process.env.CLOUD_RENDER_URL;
  if (!base) return false;
  // Fast reachability check first, so a stopped cloud box falls back to local in ~3s.
  if (!(await cloudHealthOk(base))) return false;
  // Async submit → poll → download (short requests), so a proxy's ~100s response-timeout never
  // kills a long single-clip render — e.g. a 3-5 min clip whose composite + captions run > 100s.
  const sub = await postFileExpectJson(new URL("/worker/render", base), inputPath, {
    "x-params": Buffer.from(JSON.stringify(params)).toString("base64"),
  });
  if (!sub || !sub.jobId) return false;
  // Animate 48→~92 while the worker renders (it doesn't stream progress) so a long clip doesn't
  // look frozen; give up (→ local fallback) if the box goes unreachable ~3 min or a render runs
  // past a sane ceiling, so a stuck worker never holds the bar for the full 45-min deadline.
  const submittedAt = Date.now();
  const deadline = submittedAt + 45 * 60 * 1000;
  const renderCap = submittedAt + 22 * 60 * 1000;
  const expectMs = 4 * 60 * 1000;
  let fails = 0;
  while (Date.now() < deadline) {
    await httpSleep(5000);
    const elapsed = Date.now() - submittedAt;
    onProgress(48 + 44 * (1 - Math.exp(-elapsed / expectMs)));
    const curBase = process.env.CLOUD_RENDER_URL || base; // follow a mid-render tunnel rotation
    const st = await getJson(new URL(`/worker/job/${sub.jobId}`, curBase));
    if (!st) {
      if (++fails >= 36) { logger.warn("Cloud unreachable ~3min mid-render — falling back to local render"); return false; }
      continue;
    }
    fails = 0;
    if (st.status === "done") { onProgress(96); return await getFileTo(new URL(`/worker/job/${sub.jobId}/result`, curBase), outPath); }
    if (st.status === "error") { logger.warn({ error: st.error }, "Cloud job errored"); return false; }
    if (Date.now() > renderCap) { logger.warn("Cloud render exceeded 22min without finishing — falling back to local render"); return false; }
  }
  return false;
}

// POST a file as the raw body and stream back an MP4 to outPath. Shared by the single-clip
// (/worker/render) and multi-segment (/worker/render-job) offload paths.
async function postFileExpectMp4(
  u: URL,
  filePath: string,
  extraHeaders: Record<string, string>,
  outPath: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const lib = u.protocol === "https:" ? https : http;
      const size = fs.statSync(filePath).size;
      const req = lib.request(u, {
        method: "POST",
        timeout: 45 * 60 * 1000,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(size),
          "x-worker-secret": process.env.CLOUD_RENDER_SECRET || "",
          ...extraHeaders,
        },
      }, (res) => {
        const ct = String(res.headers["content-type"] || "");
        if (res.statusCode !== 200 || !ct.includes("video/mp4")) {
          let body = ""; res.on("data", (d) => { if (body.length < 600) body += d.toString(); });
          res.on("end", () => { logger.warn({ status: res.statusCode, body }, "Cloud render did not return an MP4"); resolve(false); });
          res.on("error", () => resolve(false));
          return;
        }
        const out = fs.createWriteStream(outPath);
        res.pipe(out);
        out.on("finish", () => resolve(fs.existsSync(outPath) && fs.statSync(outPath).size > 1000));
        out.on("error", () => resolve(false));
        res.on("error", () => resolve(false));
      });
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.on("error", (e) => { logger.warn({ e }, "Cloud offload request error"); resolve(false); });
      fs.createReadStream(filePath).pipe(req);
    } catch (e) { logger.warn({ e }, "Cloud offload setup error"); resolve(false); }
  });
}

function httpSleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// POST a file and parse a small JSON response (submit an async job → { jobId }).
async function postFileExpectJson(u: URL, filePath: string, extraHeaders: Record<string, string> = {}): Promise<any | null> {
  return new Promise((resolve) => {
    try {
      const lib = u.protocol === "https:" ? https : http;
      const size = fs.statSync(filePath).size;
      const req = lib.request(u, {
        method: "POST", timeout: 10 * 60 * 1000,
        headers: { "content-type": "application/octet-stream", "content-length": String(size), "x-worker-secret": process.env.CLOUD_RENDER_SECRET || "", ...extraHeaders },
      }, (res) => {
        let body = ""; res.on("data", (d) => { body += d.toString(); });
        res.on("end", () => { try { resolve(res.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); } });
        res.on("error", () => resolve(null));
      });
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
      fs.createReadStream(filePath).pipe(req);
    } catch { resolve(null); }
  });
}

async function getJson(u: URL): Promise<any | null> {
  return new Promise((resolve) => {
    try {
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.get(u, { timeout: 20000, headers: { "x-worker-secret": process.env.CLOUD_RENDER_SECRET || "" } }, (res) => {
        let body = ""; res.on("data", (d) => { body += d.toString(); });
        res.on("end", () => { try { resolve(res.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); } });
        res.on("error", () => resolve(null));
      });
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
    } catch { resolve(null); }
  });
}

async function getFileTo(u: URL, outPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.get(u, { timeout: 30 * 60 * 1000, headers: { "x-worker-secret": process.env.CLOUD_RENDER_SECRET || "" } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); resolve(false); return; }
        const out = fs.createWriteStream(outPath);
        res.pipe(out);
        out.on("finish", () => resolve(fs.existsSync(outPath) && fs.statSync(outPath).size > 1000));
        out.on("error", () => resolve(false));
        res.on("error", () => resolve(false));
      });
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.on("error", () => resolve(false));
    } catch { resolve(false); }
  });
}

// Multi-segment cloud offload (Story / Top 5 / Match Story). The phone downloads every
// segment locally (home IP), bundles them + a job.json into a tar, and POSTs it to
// /worker/render-job; the worker runs the whole mode on the local files and returns the MP4.
// segs are NOT mutated → local fallback re-downloads cleanly. Returns false on any failure.
async function tryCloudMultiSegment(
  mode: "story" | "top5" | "matchstory",
  clipId: number,
  outPath: string,
  jobSpec: Record<string, unknown>,
  segs: StorySegment[],
  jobYoutubeUrl: string | null,
  onProgress: (p: number) => void,
): Promise<boolean> {
  const base = process.env.CLOUD_RENDER_URL;
  if (!base) return false;
  if (!(await cloudHealthOk(base))) return false;
  let bundleDir = "";
  let tarPath = "";
  try {
    const ytDlp = findYtDlp();
    bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), `cloudjob_${clipId}_`));
    const outSegs: Record<string, unknown>[] = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      const name = `seg_${i}.mp4`;
      const dest = path.join(bundleDir, name);
      // Bundle this beat's cut-engine assets (filler + punchline) so the cloud worker can read them;
      // rewrite each to a bundle-relative basename (the worker re-absolutizes it, same as localFile).
      // Without this, cloud renders silently drop every filler/punchline visual.
      const cutOverride: Record<string, unknown> = {};
      if (Array.isArray(s.fillerAssets) && s.fillerAssets.length) {
        const fills: string[] = [];
        for (let f = 0; f < s.fillerAssets.length; f++) {
          const fp = s.fillerAssets[f]!;
          if (fp && fs.existsSync(fp)) {
            const fn = `seg_${i}_fill_${f}${path.extname(fp) || ".mp4"}`;
            fs.copyFileSync(fp, path.join(bundleDir, fn));
            fills.push(fn);
          }
        }
        cutOverride.fillerAssets = fills;
      }
      if (s.punchline && s.punchline.asset && fs.existsSync(s.punchline.asset)) {
        const pn = `seg_${i}_punch${path.extname(s.punchline.asset) || ".mp4"}`;
        fs.copyFileSync(s.punchline.asset, path.join(bundleDir, pn));
        cutOverride.punchline = { word: s.punchline.word, asset: pn };
      }
      if (s.localFile && fs.existsSync(s.localFile)) {
        fs.copyFileSync(s.localFile, dest);
        outSegs.push({ ...s, localFile: name, youtubeUrl: "", sourceType: "local", ...cutOverride });
      } else {
        const url = (s.youtubeUrl && s.youtubeUrl.trim()) ? s.youtubeUrl : jobYoutubeUrl;
        if (!url) throw new Error(`Segment ${i + 1} has no source`);
        const tmp = await downloadSegment(ytDlp, url, s.startTime, s.endTime, `${clipId}_${i}`, () => {});
        fs.renameSync(tmp, dest);
        // the downloaded cut is 0-based on disk → the worker must seek from 0 for its real length
        const dur = Math.max(1, timeToSeconds(s.endTime) - timeToSeconds(s.startTime));
        outSegs.push({ ...s, localFile: name, youtubeUrl: "", sourceType: "local", startTime: "00:00:00", endTime: formatHMS(dur), ...cutOverride });
      }
      onProgress(2 + ((i + 1) / segs.length) * 25);
    }
    fs.writeFileSync(path.join(bundleDir, "job.json"), JSON.stringify({ mode, jobSpec, segments: outSegs }));
    tarPath = path.join(os.tmpdir(), `cloudjob_${clipId}_${Date.now()}.tar`);
    await execFileAsync("tar", ["-cf", tarPath, "-C", bundleDir, "."]);
    // Async: submit the bundle (worker renders in the BACKGROUND and returns a jobId), then poll
    // status + download the result — all short requests, so a proxy's response-timeout (e.g.
    // cloudflared ~100s) never kills a long multi-segment render.
    const sub = await postFileExpectJson(new URL("/worker/render-job", base), tarPath);
    if (!sub || !sub.jobId) return false;
    onProgress(30);
    // The worker doesn't stream progress, so a multi-minute render used to sit FROZEN at 30%
    // the whole time — indistinguishable from a hang (the reported "hangs at 30% across 8 polls";
    // the render was actually healthy, finishing in ~5 min). Animate the bar 30→~90 on a time
    // estimate so it visibly moves, and cap the "rendering" wait so a GENUINELY stuck worker
    // falls back to a local render instead of holding the bar for the full 45 min.
    const submittedAt = Date.now();
    const deadline = submittedAt + 45 * 60 * 1000;
    const renderCap = submittedAt + 22 * 60 * 1000; // hard ceiling for the "rendering" state
    const expectMs = 6 * 60 * 1000;                 // typical multi-seg cloud render; ramp shape only
    let fails = 0;
    while (Date.now() < deadline) {
      await httpSleep(5000);
      // Asymptotic ramp toward 90 (never reaches it until the job actually reports "done").
      const elapsed = Date.now() - submittedAt;
      onProgress(30 + 60 * (1 - Math.exp(-elapsed / expectMs)));
      // Re-read CLOUD_RENDER_URL each poll so a mid-render tunnel rotation (`cloud on` re-points it;
      // the worker + its job survive the rotation) is FOLLOWED instead of orphaning the poll on the
      // dead old URL. And never poll a dead URL forever: after ~3 min of consecutive failures, give
      // up so the caller falls back to a LOCAL render instead of stalling the clip at 30% (the clip-71 bug).
      const curBase = process.env.CLOUD_RENDER_URL || base;
      const st = await getJson(new URL(`/worker/job/${sub.jobId}`, curBase));
      if (!st) {
        if (++fails >= 36) { logger.warn("Cloud unreachable ~3min mid-render — falling back to local render"); return false; }
        continue;
      }
      fails = 0;
      if (st.status === "done") { onProgress(95); return await getFileTo(new URL(`/worker/job/${sub.jobId}/result`, curBase), outPath); }
      if (st.status === "error") { logger.warn({ error: st.error }, "Cloud job errored"); return false; }
      if (Date.now() > renderCap) { logger.warn("Cloud render exceeded 22min without finishing — falling back to local render"); return false; }
    }
    return false;
  } catch (e) {
    logger.warn({ e }, "Cloud multi-segment offload failed — rendering locally");
    return false;
  } finally {
    try { if (bundleDir) fs.rmSync(bundleDir, { recursive: true, force: true }); } catch { /* */ }
    try { if (tarPath && fs.existsSync(tarPath)) fs.unlinkSync(tarPath); } catch { /* */ }
  }
}

export async function processClip(
  youtubeUrl: string | null,
  startTime: string,
  endTime: string,
  headline: string,
  outputFilename: string,
  mode: "edited" | "raw" = "edited",
  channelHandle = "",
  clipId = 0,
  localFilePath?: string,
  frameStyle: "standard" | "immersive" = "immersive",
  sourceChannel = "",
  captionsEnabled = true,
  outroEnabled = true,
  voiceoverEnabled = false,
  voiceoverHook = "",
  punchInEnabled = false,
  zoomMoments = "",
  captionColor = "",
  voiceoverMode: "hook" | "script" = "hook",
  narrationScript = "",
  voiceOpts: VoiceOpts = {},
  // Top-5 only: when set, a big gold "#N" rank number is burned CENTERED ABOVE the moment's
  // title (drawn here in the composite, where the title's Y is known, so it always sits just
  // above the headline instead of over the footage). The title's height is trimmed to leave
  // room for it. Left undefined for normal clips/story.
  topRank?: number
): Promise<void> {
  const isLocalFile = !!localFilePath;
  const ytDlp = findYtDlp();
  const outputDir = getOutputDir();
  const finalOutputPath = path.join(outputDir, outputFilename);
  // Voice + pace for this clip's hook / full narration (resolved once).
  const jobVoice = resolveVoice(voiceOpts.voice, voiceoverMode === "script" ? "script" : "hook");
  const jobSpeed = resolveSpeed(voiceOpts.speed);

  const startSeconds = timeToSeconds(startTime);
  const endSeconds = timeToSeconds(endTime);
  // `let` (not const): if the source has less footage than requested (e.g. the cut runs past
  // the end of the video), we clamp this to the real available footage so the composite never
  // pads the shortfall with a frozen held frame. See the short-download guard after download.
  let duration = endSeconds - startSeconds;

  if (duration <= 0) throw new Error("End time must be after start time");

  const updateProgress = makeProgressUpdater(clipId);

  // Unique ID for temp files per clip to avoid collisions between concurrent jobs
  const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

  let tmpInputPath: string | null = null;

  try {
    if (isLocalFile) {
      // Step 1 (local): file already on disk — skip yt-dlp entirely
      tmpInputPath = localFilePath;
      logger.info({ tmpInputPath, mode }, "Using local uploaded file");
      await updateProgress(5, true);
    } else {
      // Step 1 (YouTube): download the exact segment — reports 2-48% progress
      await updateProgress(0, true);
      tmpInputPath = await downloadSegment(
        ytDlp,
        youtubeUrl!,
        startTime,
        endTime,
        tmpId,
        (pct) => { void updateProgress(pct); }
      );
      logger.info({ tmpInputPath, mode }, "Segment downloaded");

      // Deep-in-a-livestream section cuts can come back with NO frame timestamps, which
      // makes the composite filtergraph emit 0 frames (a permanent frame-0 stall). Repair
      // those before compositing; normal clips (valid pts) skip this untouched.
      if (!(await segmentHasValidTimestamps(tmpInputPath))) {
        tmpInputPath = await normalizeSegmentTimestamps(tmpInputPath, tmpId);
      }

      // Short-download guard (the "frozen clip" fix). A cut that runs past the end of the
      // source video — or any truncated download — comes back with far less footage than the
      // requested window. The composite below uses `-t duration`, so the missing seconds get
      // padded with a single held frame → a video that "freezes" for most of its length.
      // Detect the shortfall from the actual content duration and handle it explicitly.
      const contentDuration = await probeContentDuration(tmpInputPath);
      if (contentDuration > 0 && contentDuration < duration - 1.5) {
        // Grossly short (under ~5s, or less than 60% of the request): the window is largely
        // past the end of the video. Retrying won't help — the timestamps are the problem —
        // so fail with an actionable message instead of shipping a mostly-frozen clip.
        if (contentDuration < Math.min(5, duration * 0.6)) {
          throw new Error(
            `Only ${contentDuration.toFixed(1)}s of footage is available for the requested ${Math.round(duration)}s segment (${startTime}–${endTime}). The clip time is likely past the end of the video — check the timestamps against the video's actual length.`
          );
        }
        // Minor shortfall: clamp the render to the real footage so we never freeze-pad.
        logger.warn(
          { requestedDuration: duration, contentDuration },
          "Downloaded segment shorter than requested — clamping render duration to available footage (avoids freeze-pad)"
        );
        duration = contentDuration;
      }
      await updateProgress(45, true);
    }

    // Raw mode: for local files trim with ffmpeg copy; for YouTube just copy the downloaded segment
    if (mode === "raw") {
      if (isLocalFile) {
        await spawnProcess("ffmpeg", [
          "-y",
          "-ss", startTime,
          "-i", tmpInputPath,
          "-t", String(duration),
          "-c", "copy",
          finalOutputPath,
        ], 300_000);
      } else {
        fs.copyFileSync(tmpInputPath, finalOutputPath);
      }
      logger.info({ finalOutputPath }, "Raw clip saved (no compositing)");
      return;
    }

    // ── Cloud offload (optional, edited mode) ───────────────────────────────────
    // If a cloud worker is configured AND reachable, render the heavy composite there
    // and skip the local ffmpeg pipeline entirely. We only offload YouTube clips: by
    // now tmpInputPath is a small pre-cut, 0-based segment, so startTime "00:00:00" +
    // the (clamped) duration reproduce the exact same cut on the worker. Local uploads
    // (potentially huge) always render locally. ANY failure falls through to local.
    if (process.env.CLOUD_RENDER_URL && !isLocalFile && tmpInputPath) {
      await updateProgress(48, true);
      const ok = await offloadToCloud(tmpInputPath, finalOutputPath, {
        headline, mode: "edited", channelHandle, frameStyle, sourceChannel,
        captionsEnabled, outroEnabled, voiceoverEnabled, voiceoverHook,
        punchInEnabled, zoomMoments, captionColor, voiceoverMode, narrationScript,
        voiceoverVoice: jobVoice, voiceoverSpeed: jobSpeed,
        startTime: "00:00:00", endTime: formatHMS(duration), topRank,
      }, (p) => { void updateProgress(p); });
      if (ok) {
        logger.info({ finalOutputPath }, "Clip rendered on cloud worker (offloaded)");
        await updateProgress(100, true);
        return;
      }
      logger.warn("Cloud offload unavailable/failed — rendering locally");
    }

    logger.info({ tmpInputPath }, "Building filter graph for edited mode");

    // Step 2: Render headline text to a transparent PNG via Python.
    // This handles emoji (pilmoji/Twemoji) which ffmpeg drawtext cannot render.
    const canvasW = 1080;
    const canvasH = 1920;
    const videoW = 1080;
    const videoH = frameStyle === "standard" ? 608 : 1350;
    const videoY = 240;    // top bar for title; 240 (not 200) drops the title + frame
                           // ~40px so the headline clears YouTube's top UI (back/search/
                           // menu icons). Bottom bar stays 330px — ample for the watermark.

    const fontSize = 96;
    const lineSpacing = 14;

    const fontFile = findFont();
    // Headlines render in Anton (bold condensed display face) — its capital "I"
    // is a thick full-height bar that can't be mistaken for a lowercase "l", and
    // it gives the punchy, professional look expected of Shorts titles.
    const headlineFont = fs.existsSync(ANTON_FONT) ? ANTON_FONT : fontFile;
    let tmpPngPath: string | null = null;
    let pngHeight = 0;

    if (headline && headline.trim()) {
      tmpPngPath = path.join(os.tmpdir(), `clip_hl_${tmpId}.png`);
      const renderParams = JSON.stringify({
        // Upper-case for the bold Shorts headline style (also removes any
        // remaining ambiguity between similar glyphs).
        text: headline.toUpperCase(),
        font_path: headlineFont,
        font_size: fontSize,
        line_spacing: lineSpacing,
        max_chars: 28,
        canvas_width: canvasW,
        // Keep the title block inside the top bar (videoY tall) with breathing room. For a
        // Top-5 moment, trim it further so the "#N" rank number has a clear strip above it.
        max_height: videoY - 40 - (topRank ? 96 : 0),
        output_path: tmpPngPath,
      });
      const python3 = findPython();
      const renderOutput = await execFileAsync(python3, [RENDER_HEADLINE_SCRIPT, renderParams], { timeout: 30000 });
      const renderResult = JSON.parse(renderOutput.stdout.trim()) as { height: number; lines: number };
      pngHeight = renderResult.height;
      logger.info({ tmpPngPath, pngHeight, lines: renderResult.lines }, "Headline PNG rendered");
    }

    await updateProgress(45, true);

    // Position: BOTTOM-anchor the headline just above the red line (bottom of the top
    // bar), leaving the top of the bar empty for YouTube's top UI (back/search/menu).
    // 1-line titles then sit low near the frame; 2-line titles fill the bar and stay
    // clear of the red drawbox at y=videoY-3. Guarded so an oversized PNG never goes
    // off the top.
    const hlY = Math.max(12, videoY - pngHeight - 12);

    // Detect if the source video already has a logo/watermark in the bottom-center
    // area where our channel handle would go, and shift ours right if so.
    let handleX = "(w-text_w)/2";
    if (channelHandle && channelHandle.trim() && tmpInputPath) {
      try {
        const framePath = path.join(os.tmpdir(), `clip_frame_${tmpId}.png`);
        await spawnProcess("ffmpeg", [
          "-y",
          "-ss", String(duration / 2),
          "-i", tmpInputPath,
          "-vf", `scale=${videoW}:${videoH}:force_original_aspect_ratio=increase,crop=${videoW}:${videoH}`,
          "-vframes", "1",
          framePath,
        ], 30000);

        const python3 = findPython();
        const detectParams = JSON.stringify({
          frame_path: framePath,
          region_w: 360,
          region_h: 50,
          frame_w: videoW,
          frame_h: videoH,
        });
        const detectOutput = await execFileAsync(python3, [DETECT_OVERLAP_SCRIPT, detectParams], { timeout: 15000 });
        const detectResult = JSON.parse(detectOutput.stdout.trim()) as { busy: boolean; stddev: number };
        logger.info({ detectResult }, "Watermark overlap detection");
        if (detectResult.busy) {
          handleX = "w-text_w-40";
        }
      } catch (err) {
        logger.warn({ err }, "Watermark overlap detection failed \u2014 using centered position");
      }
    }

    // AI auto-zoom: at each moment Gemini chose (or evenly-spaced defaults) apply the
    // zoom TYPE it picked. ALL six types are a lanczos animated scale + crop driven by a
    // per-frame zoom factor Z(t) — NEVER zoompan (which blurred badly and forced 25/30fps).
    // This keeps the source frame rate and stays sharp. Each effect is a localised bump on
    // Z(t) that is always >= 0, so Z >= 1 everywhere → the scale never goes below the output
    // size → no upscale-from-smaller → no blur. Expressions stay comma-free (commas would
    // split the filtergraph) — |u| via sqrt(u*u), squaring via self-multiply, no pow/^.
    let punchInChain = "";
    if (punchInEnabled) {
      const parsed = parseZoomEvents(zoomMoments, duration);
      const events = parsed.length ? parsed : defaultZoomEvents(duration);
      const zTerms: string[] = [];   // added to the zoom factor Z(t)
      const panXTerms: string[] = []; // crop-centre horizontal drift (Ken Burns only)
      const panYTerms: string[] = []; // crop-centre vertical drift (Ken Burns only)
      let kbIdx = 0;
      for (const ev of events) {
        const c = ev.sec.toFixed(2);
        const u = `(t-${c})`;                       // time relative to the moment
        const up = `((${u}+sqrt(${u}*${u}))/2)`;    // max(u,0): the "after" half
        const un = `((${u}-sqrt(${u}*${u}))/2)`;    // min(u,0): the "before" half
        switch (ev.type) {
          case "whip": {            // fast, strong snap
            const a = `(${u}/0.16)`;
            zTerms.push(`0.34*exp(-${a}*${a})`);
            break;
          }
          case "cut": {             // near-rectangular hold (super-gaussian, 4th power)
            const q = `(${u}/0.55)`;
            const q2 = `(${q}*${q})`;
            zTerms.push(`0.24*exp(-${q2}*${q2})`);
            break;
          }
          case "pushin": {          // slow build-in, quicker release
            const ar = `(${un}/1.30)`;
            const af = `(${up}/0.70)`;
            zTerms.push(`0.20*exp(-${ar}*${ar}-${af}*${af})`);
            break;
          }
          case "pullout": {         // snap in, slow reveal out
            const ar = `(${un}/0.22)`;
            const af = `(${up}/1.50)`;
            zTerms.push(`0.22*exp(-${ar}*${ar}-${af}*${af})`);
            break;
          }
          case "kenburns": {        // gentle wide zoom + slow diagonal pan
            const a = `(${u}/1.40)`;
            zTerms.push(`0.14*exp(-${a}*${a})`);
            const dir = kbIdx % 2 === 0 ? 1 : -1;   // alternate drift so adjacent KBs differ
            const pw = `(${u}/1.20)`;               // odd drift u*exp(-u^2): sweeps through centre
            panXTerms.push(`${(dir * 1.20).toFixed(2)}*${pw}*exp(-${pw}*${pw})`);
            panYTerms.push(`${(-dir * 1.40).toFixed(2)}*${pw}*exp(-${pw}*${pw})`);
            kbIdx++;
            break;
          }
          case "punch":
          default: {                // quick symmetric zoom in/out (the original)
            const a = `(${u}/0.45)`;
            zTerms.push(`0.18*exp(-${a}*${a})`);
            break;
          }
        }
      }
      if (zTerms.length) {
        const zExpr = `1${zTerms.map((t) => `+${t}`).join("")}`;
        const scalePart = `scale=w=ceil(${videoW}*(${zExpr})/2)*2:h=ceil(${videoH}*(${zExpr})/2)*2:eval=frame:flags=lanczos`;
        let cropPart = `crop=${videoW}:${videoH}`;
        if (panXTerms.length || panYTerms.length) {
          // Offset the centre crop by a fraction of the available margin. The margin
          // ((in_w-W)/2) shrinks to 0 as Z→1, and |pan|<1, so x/y stay in [0, in-out].
          // ffmpeg 8.x evaluates crop x/y per-frame by default (no `eval` option — it
          // was removed), so the t-driven pan animates without it.
          const panX = panXTerms.length ? panXTerms.join("+") : "0";
          const panY = panYTerms.length ? panYTerms.join("+") : "0";
          cropPart = `crop=${videoW}:${videoH}:x=(in_w-${videoW})/2*(1+(${panX})):y=(in_h-${videoH})/2*(1+(${panY}))`;
        }
        punchInChain = `,${scalePart},${cropPart}`;
        const typeCounts = events.reduce<Record<string, number>>((m, e) => { m[e.type] = (m[e.type] ?? 0) + 1; return m; }, {});
        logger.info({ events, typeCounts, source: parsed.length ? "ai" : "default" }, "AI auto-zoom (multi-type) applied");
      }
    }

    // Step 3: Build ffmpeg filter graph
    // Inputs: [0] = downloaded video clip, [1] = headline PNG (if headline is set)
    const extraInputs: string[] = [];
    const filters: string[] = [
      // Split the source: one copy becomes a blurred, dimmed full-frame backdrop
      // (true "immersive" look), the other is the sharp centred video.
      `[0:v]split=2[vsrc][vbg]`,
      `[vbg]scale=216:384:force_original_aspect_ratio=increase,crop=216:384,gblur=sigma=9,scale=${canvasW}:${canvasH}:flags=bilinear,eq=brightness=-0.30:saturation=1.15[bg]`,
      `[vsrc]scale=${videoW}:${videoH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${videoW}:${videoH}${punchInChain},unsharp=5:5:1.0:5:5:0.0[vid]`,
      `[bg][vid]overlay=0:${videoY}[composedv]`,
      // Soft dark scrims behind the title and handle so white text stays legible
      // over the blurred backdrop.
      `[composedv]drawbox=x=0:y=0:w=${canvasW}:h=${videoY}:color=black@0.30:t=fill[scrimtop]`,
      `[scrimtop]drawbox=x=0:y=${videoY + videoH}:w=${canvasW}:h=${canvasH - videoY - videoH}:color=black@0.30:t=fill[composedsc]`,
      `[composedsc]drawbox=x=0:y=${videoY - 3}:w=${canvasW}:h=3:color=FF0000:t=fill[composedac]`,
      // Credit line, bottom-LEFT of the video frame. Left (not right) so it never clashes
      // with the source creator's own logo/handle, which almost always sits bottom-centre/
      // right. Rendered "Credit:- <name>" (name in its natural case). The colon must be
      // backslash-escaped INSIDE the single-quoted value or ffmpeg's filtergraph parser
      // treats it as an option separator (verified: only text='Credit\:- x' parses).
      sourceChannel && sourceChannel.trim() ? `[composedac]drawtext=text='Credit\\:- ${sourceChannel.trim().replace(/['\\]/g,"")}':fontsize=24:fontcolor=white@0.85:x=16:y=${videoY + videoH - 36}:shadowx=1:shadowy=1:shadowcolor=black@0.9[composed]` : `[composedac]null[composed]`,
    ];
    let prevLabel = "composed";

    if (tmpPngPath && pngHeight > 0) {
      // -loop 1 makes the still PNG repeat for the full video duration; -t (below) cuts it
      extraInputs.push("-loop", "1", "-i", tmpPngPath);
      filters.push(`[1:v]format=rgba[hl]`);
      filters.push(`[${prevLabel}][hl]overlay=x=0:y=${hlY}[after_hl]`);
      prevLabel = "after_hl";
    }

    // Top 5: big gold "#N" rank number, centered in the strip ABOVE the title (reserved via
    // the trimmed headline max_height above). Drawn here — not in a later pass — because this
    // is where the title's Y (hlY) is known, so the number always lands just above it.
    if (topRank) {
      filters.push(
        `[${prevLabel}]drawtext=fontfile='${headlineFont}':text='#${topRank}':fontsize=92:fontcolor=0xF5C518:borderw=6:bordercolor=black:shadowx=2:shadowy=2:shadowcolor=black@0.8:x=(w-text_w)/2:y=(${hlY}-text_h)/2[after_rank]`
      );
      prevLabel = "after_rank";
    }

    // Channel handle watermark: small white text with shadow near the bottom of the video frame.
    //
    // ⚠️ WATERMARK OWNERSHIP — there are TWO systems, and only ONE may fire per render:
    //   • SINGLE-clip renders (routes/clips.ts → processClip directly) burn their captions
    //     inline below and NEVER call burnCaptionsOnFile, so this drawtext is their only
    //     watermark. It must keep working.
    //   • MULTI-segment modes (processStory / processMatchStory / processTop5) finish with
    //     burnCaptionsOnFile(..., WATERMARK_HANDLE), which stamps the canonical low-center
    //     watermark over the whole video. Those modes therefore pass channelHandle="" into
    //     their per-beat processClip calls — otherwise every beat gets this bold handle AND
    //     the final pass adds the light one, which shipped as a visible double watermark.
    // If you re-introduce channelHandle to a multi-segment call site, remove the
    // WATERMARK_HANDLE burn for that mode, or you will double-stamp again.
    if (channelHandle && channelHandle.trim()) {
      // Watermark uses Anton (bold condensed display face, same as the headline) in
      // uppercase so it reads strongly. It lives in the black bar below the video, so
      // it is always horizontally centered — the source-watermark overlap shift in
      // handleX only matters for text drawn over the video frame, not down here.
      const safeHandle = escapeDrawtext(channelHandle.trim().toUpperCase());
      const handleFont = fs.existsSync(ANTON_FONT) ? ANTON_FONT : (fs.existsSync(WATERMARK_FONT) ? WATERMARK_FONT : fontFile);
      const handleFontSize = 48;
      // Immersive: hug the TOP of the bottom bar (just under the video) so YouTube's bottom
      // Shorts overlay can't cover the handle. Standard's bottom bar is huge (videoH=608 →
      // ~1072px bar), so keep it centered there to avoid a big empty gap below the handle.
      const handleY = frameStyle === "standard"
        ? videoY + videoH + Math.floor((canvasH - videoY - videoH - handleFontSize) / 2)
        : videoY + videoH + 20;
      filters.push(
        `[${prevLabel}]drawtext=` +
        `text='${safeHandle}':` +
        `fontfile='${handleFont}':` +
        `fontsize=${handleFontSize}:` +
        `fontcolor=white:` +
        `borderw=3:bordercolor=black@0.55:` +
        `shadowx=2:shadowy=2:shadowcolor=black@0.85:` +
        `x=(w-text_w)/2:` +
        `y=${handleY}` +
        `[pre_outro]`
      );
    } else {
      filters.push(`[${prevLabel}]null[pre_outro]`);
    }

    if (outroEnabled) {
      // Outro card: last 2 seconds = full-black end screen with a single big, bold
      // red SUBSCRIBE centered on both axes — matches the reference outro exactly.
      const outroStart = Math.max(0, duration - 2);
      const subFont = fs.existsSync(WATERMARK_FONT) ? WATERMARK_FONT : fontFile;
      filters.push(
        // Full-screen black card
        `[pre_outro]drawbox=x=0:y=0:w=${canvasW}:h=${canvasH}:color=black@1:t=fill:enable='gte(t,${outroStart})'[ob]`,
        // Bold red SUBSCRIBE, centered — same-color border thickens the strokes to a heavy weight
        `[ob]drawtext=fontfile='${subFont}':text='SUBSCRIBE':fontsize=150:fontcolor=FF0000:borderw=4:bordercolor=FF0000:x=(w-text_w)/2:y=(h-text_h)/2:enable='gte(t,${outroStart})'[out]`
      );
    } else {
      filters.push(`[pre_outro]null[out]`);
    }

    const filterComplex = filters.join(";");

    // Detect whether the source has an audio track so we can (a) safely apply an
    // audio filter and (b) fade the audio out under the outro card instead of
    // letting dialogue play over the subscribe screen.
    let hasAudio = false;
    try {
      const probe = await execFileAsync("ffprobe", [
        "-v", "error", "-select_streams", "a",
        "-show_entries", "stream=index", "-of", "csv=p=0", tmpInputPath,
      ], { timeout: 15000 });
      hasAudio = probe.stdout.trim().length > 0;
    } catch { /* assume no audio */ }

    // Build the audio filter chain. When the source has audio we always normalise
    // loudness to YouTube's target (-14 LUFS integrated, -1.5 dBTP true peak) so
    // every clip sounds consistent and at the platform's reference level instead
    // of whatever the source happened to be. Single-pass loudnorm is light enough
    // for the phone; two-pass would be more accurate but needs a separate analysis
    // run. Then, if the outro card is enabled, gently duck the audio out across the
    // last 3s so it's already quiet by the time the subscribe screen appears.
    const audioFilterChain: string[] = [];
    if (hasAudio) {
      // Correct any initial audio/video offset introduced by yt-dlp's keyframe-imprecise
      // section cut (video and audio can start a hair apart → lips out of sync at the start).
      audioFilterChain.push("aresample=async=1");
      audioFilterChain.push("loudnorm=I=-14:TP=-1.5:LRA=11");
      if (outroEnabled) {
        audioFilterChain.push(`afade=t=out:st=${Math.max(0, duration - 3)}:d=3`);
      }
    }
    const outroAudioFade = audioFilterChain.length
      ? ["-af", audioFilterChain.join(",")]
      : [];

    // Step 4: Run ffmpeg, reporting 55-95% progress by parsing time= lines
    // For local files, add fast input-side seek (-ss before -i) so ffmpeg trims precisely
    const ffmpegArgs: string[] = [
      "-y",
      ...(isLocalFile ? ["-ss", startTime] : []),
      "-i", tmpInputPath,
      ...extraInputs,
      "-filter_complex", filterComplex,
      "-map", "[out]",
      "-map", "0:a?",
      ...outroAudioFade,
      "-c:v", "libx264",
      "-threads", "1",
      "-preset", "veryfast",
      "-crf", "14",

      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "256k",
      "-t", String(duration),
      "-movflags", "+faststart",
      finalOutputPath,
    ];

    logger.info({ pngHeight, channelHandle, fontFile }, "Starting ffmpeg");

    // No hard timeout: the immersive composite is CPU-bound and can run long on the
    // phone. The stall timer is the only guard, so it must be GENEROUS: the AI-auto-zoom +
    // immersive filtergraph on a 1080p60 source can go silent for well over the old 90s
    // default during filtergraph init / first-frame decode, or when the memory-starved phone
    // briefly thrashes — that silence is NOT a hang, but the 90s timer was killing these
    // healthy renders mid-way (and then mislabeling it "Download timed out"). RENDER_STALL_MS
    // (15 min) only fires on a genuinely dead process while letting slow renders finish.
    await spawnProcess("ffmpeg", ffmpegArgs, 0, (line) => {
      // ffmpeg progress: "... time=00:00:04.10 ..."
      const m = line.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      if (m) {
        const elapsed =
          parseInt(m[1]!) * 3600 + parseInt(m[2]!) * 60 + parseFloat(m[3]!);
        const ratio = Math.min(elapsed / duration, 1);
        // Map ffmpeg 0-100% → overall 55-95%
        void updateProgress(45 + ratio * 50);
      }
    }, RENDER_STALL_MS, "render");

    logger.info({ finalOutputPath }, "Clip processing complete");

    // Extract best frame as thumbnail (non-fatal)
    if (clipId) {
      const thumbPath = path.join(outputDir, `clip_${clipId}_thumb.jpg`);
      try {
        await spawnProcess("ffmpeg", [
          "-y", "-i", finalOutputPath,
          "-vf", "thumbnail=300",
          "-frames:v", "1",
          thumbPath,
        ], 60000, () => {});
        logger.info({ thumbPath }, "Thumbnail extracted");
      } catch (thumbErr) {
        logger.warn({ thumbErr }, "Thumbnail extraction failed (non-fatal)");
      }

      // Generate captions via whisper.cpp + burn into video (non-fatal)
      if (captionsEnabled) try {
        const srtPath = path.join(outputDir, `clip_${clipId}_captions.srt`);
        const transcriptPath = path.join(outputDir, `clip_${clipId}_transcript.txt`);
        const captionScript = path.join(os.homedir(), "myapp/scripts/generate_captions_pro.sh");
        const captionedPath = path.join(outputDir, `clip_${clipId}_captioned.mp4`);

        if (fs.existsSync(captionScript)) {
          // Capture exit code + the script's own OK/FAIL line so a failed whisper
          // run is logged loudly instead of silently shipping an uncaptioned clip.
          // 60 min cap: medium.en-q5 on the phone is ~16 min for a 60s clip (~16x
          // realtime); a 30 min cap would time-out (and drop captions on) longer clips.
          const capResult = await new Promise<{ code: number | null; out: string }>((resolve) => {
            const cap = spawn("bash", [captionScript, finalOutputPath, srtPath, transcriptPath], { timeout: 3_600_000 });
            let out = "";
            cap.stdout?.on("data", (d) => { out += d.toString(); });
            cap.on("close", (code) => resolve({ code, out }));
            cap.on("error", (err) => resolve({ code: -1, out: String(err) }));
          });
          if (capResult.code !== 0 || /\bFAIL\b/.test(capResult.out)) {
            logger.warn(
              { clipId, exitCode: capResult.code, tail: capResult.out.slice(-400) },
              "Caption script failed (whisper/transcription) — clip may be uncaptioned or partial"
            );
          }

          if (fs.existsSync(transcriptPath)) {
            try {
              const transcript = fs.readFileSync(transcriptPath, "utf8").trim();
              if (transcript) {
                await db.update(clipsTable).set({ transcript }).where(eq(clipsTable.id, clipId));
              }
            } catch { /* non-fatal */ }
            fs.unlinkSync(transcriptPath);
          }

          if (fs.existsSync(srtPath)) {
            // Convert the cleaned SRT into animated word-by-word ("karaoke")
            // captions (active word highlighted). Fall back to a plain bold-SRT
            // burn if the converter is missing or produces nothing.
            // NB: Anton is great for the PIL-rendered headline, but libass
            // double-renders it into a ghosted outline — captions use DejaVu Sans.
            const assPath = path.join(outputDir, `clip_${clipId}_captions.ass`);
            // DTW karaoke: word-level highlighting from whisper's per-token DTW
            // timestamps (JSON emitted alongside the SRT by generate_captions_pro.sh),
            // so each word lights up exactly when spoken. Falls back to the plain
            // SRT burn if the JSON/converter is missing or yields no Dialogue lines.
            const dtwJsonPath = srtPath.replace(/\.srt$/, ".json");
            const karaokeScript = path.join(os.homedir(), "myapp/scripts/karaoke_captions_pro.py");
            let subFilter = `subtitles=${srtPath}:fontsdir=${FONTS_DIR}:force_style='FontName=DejaVu Sans,FontSize=12,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=1,Bold=1,Alignment=2,MarginV=95'`;
            let haveAss = false;
            if (fs.existsSync(karaokeScript) && fs.existsSync(dtwJsonPath)) {
              try {
                // Caption cutoff = where the outro subscribe card starts (last 2s),
                // so captions don't sit over it. With the outro OFF there is no card,
                // so let captions run to the very end (was wrongly clipping the final 2s).
                const captionEnd = outroEnabled ? Math.max(0, duration - 2) : duration;
                // Pass the user-chosen highlight colour (blank => the script's classic yellow).
                await execFileAsync(findPython(), [karaokeScript, dtwJsonPath, assPath, String(captionEnd), captionColor || ""], { timeout: 30000 });
                if (fs.existsSync(assPath) && fs.readFileSync(assPath, "utf8").includes("Dialogue:")) {
                  subFilter = `subtitles=${assPath}:fontsdir=${FONTS_DIR}`;
                  haveAss = true;
                }
              } catch (kErr) {
                logger.warn({ kErr }, "Karaoke caption generation failed — falling back to plain SRT");
              }
            }

            // A no-speech / non-English segment yields an empty SRT and no ASS
            // Dialogue lines. Burning an empty subtitle file makes ffmpeg error,
            // so skip the burn entirely and leave the clip uncaptioned.
            const srtHasContent = (() => {
              try { return fs.readFileSync(srtPath, "utf8").trim().length > 0; }
              catch { return false; }
            })();

            if (haveAss || srtHasContent) {
              await spawnProcess("ffmpeg", [
                "-y", "-i", finalOutputPath,
                "-vf", subFilter,
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-threads", "1",
                "-c:a", "copy",
                captionedPath,
                // No hard timeout — caption burn is another full crf-14 re-encode that
                // can also exceed 10 min on the phone; the generous render stall timer
                // (RENDER_STALL_MS) guards a genuine hang without killing a slow re-encode.
              ], 0, () => {}, RENDER_STALL_MS, "render");

              if (fs.existsSync(captionedPath)) {
                fs.renameSync(captionedPath, finalOutputPath);
                logger.info({ finalOutputPath, mode: haveAss ? "dtw-karaoke" : "srt" }, "Captions burned into clip");
              }
            } else {
              logger.info({ clipId }, "No speech detected in segment — skipping caption burn");
            }
            fs.existsSync(srtPath) && fs.unlinkSync(srtPath);
            fs.existsSync(assPath) && fs.unlinkSync(assPath);
            fs.existsSync(dtwJsonPath) && fs.unlinkSync(dtwJsonPath);
          }
        }
      } catch (capErr) {
        logger.warn({ capErr }, "Caption generation failed (non-fatal)");
      }

      // Pro: FULL NARRATION MODE. Speak N timed lines across the clip (Piper TTS,
      // local), ducking the original audio to ~22% only WHILE a line plays and back
      // to full between lines. One cheap audio-only pass (video stream copied). A line
      // whose WAV fails to synth is skipped; if none survive, the clip ships un-narrated.
      if (voiceoverEnabled && voiceoverMode === "script" && narrationScript && narrationScript.trim()) try {
        const lines = parseNarrationLines(narrationScript, duration, outroEnabled);
        const wavPaths: string[] = [];
        const spoken: { start: number; end: number }[] = [];
        for (const [i, ln] of lines.entries()) {
          const wav = path.join(outputDir, `clip_${clipId}_narr_${i}.wav`);
          if (!(await generateNarrationWav(ln.text, wav, jobVoice, jobSpeed))) {
            logger.warn({ clipId, line: i }, "Narration WAV not produced — skipping this line");
            continue;
          }
          const wdur = (await probeContentDuration(wav)) || 3;
          wavPaths.push(wav);
          // Duck window = while the line plays + a short tail so dialogue returns cleanly.
          spoken.push({ start: ln.sec, end: ln.sec + wdur + 0.4 });
        }

        if (spoken.length > 0) {
          // Does the current file still have an audio stream to duck under narration?
          let narrHasAudio = false;
          try {
            const p = await execFileAsync("ffprobe", [
              "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
              "-of", "csv=p=0", finalOutputPath,
            ], { timeout: 10000 });
            narrHasAudio = p.stdout.trim().length > 0;
          } catch { /* assume none */ }

          // Inputs: [0]=video, [1..N]=narration WAVs, and (only when the source has no
          // audio) a fixed-length silent bed so amix still has a full-length base to key
          // duration=first off (an anullsrc SOURCE would otherwise run forever).
          const ffInputs: string[] = ["-y", "-i", finalOutputPath];
          for (const w of wavPaths) ffInputs.push("-i", w);
          const anullIdx = 1 + wavPaths.length;
          if (!narrHasAudio) ffInputs.push("-f", "lavfi", "-t", String(duration), "-i", "anullsrc=r=48000:cl=stereo");

          const parts: string[] = [];
          if (narrHasAudio) {
            // Duck the original only across the UNION of narration intervals. between()
            // is 0/1 and volume's `enable` treats any non-zero as true → overlapping
            // intervals are handled for free, no interval-merging needed.
            const enableExpr = spoken.map((s) => `between(t,${s.start.toFixed(2)},${s.end.toFixed(2)})`).join("+");
            parts.push(`[0:a]volume=enable='${enableExpr}':volume=0.22,aresample=48000,aformat=channel_layouts=stereo[base]`);
          } else {
            parts.push(`[${anullIdx}:a]aresample=48000,aformat=channel_layouts=stereo[base]`);
          }
          const mixLabels: string[] = ["[base]"];
          wavPaths.forEach((_w, i) => {
            const inIdx = i + 1;
            const delayMs = Math.round(spoken[i]!.start * 1000);
            parts.push(`[${inIdx}:a]adelay=${delayMs}:all=1,aresample=48000,aformat=channel_layouts=stereo[n${inIdx}]`);
            mixLabels.push(`[n${inIdx}]`);
          });
          // duration=first ties the output length to [base] (source audio ≈ clip, or the
          // silent bed = clip duration), so any narration tail past clip end is trimmed.
          parts.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);

          const narratedPath = path.join(outputDir, `clip_${clipId}_narrated.mp4`);
          await spawnProcess("ffmpeg", [
            ...ffInputs,
            "-filter_complex", parts.join(";"),
            "-map", "0:v", "-map", "[aout]",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
            "-movflags", "+faststart",
            narratedPath,
          ], 300_000, () => {});

          if (fs.existsSync(narratedPath)) {
            fs.renameSync(narratedPath, finalOutputPath);
            logger.info({ finalOutputPath, lines: spoken.length }, "Full narration mixed in");
          }
        } else {
          logger.warn({ clipId }, "No narration lines produced — skipping narration mix");
        }

        for (const w of wavPaths) { try { fs.existsSync(w) && fs.unlinkSync(w); } catch { /* ignore */ } }
      } catch (naErr) {
        logger.warn({ naErr }, "Narration generation failed (non-fatal)");
      }

      // Pro: AI intro-hook voiceover. Speak the user-supplied hook line (Piper TTS,
      // local) over the first few seconds with the original audio ducked underneath.
      // Runs as a cheap audio-only pass — the video stream is copied, only the audio
      // is re-encoded — so it adds negligible time even on the phone. Non-fatal.
      // Skipped in "script" mode (the narration block above owns the audio then).
      if (voiceoverEnabled && voiceoverMode !== "script" && voiceoverHook && voiceoverHook.trim()) try {
        const hookWav = path.join(outputDir, `clip_${clipId}_hook.wav`);
        const voiceScript = path.join(os.homedir(), "myapp/scripts/generate_voiceover.sh");

        if (fs.existsSync(voiceScript)) {
          await new Promise<void>((resolve) => {
            const v = spawn("bash", [voiceScript, voiceoverHook.trim(), hookWav, jobVoice, jobSpeed], { timeout: 120_000 });
            v.on("close", () => resolve());
            v.on("error", () => resolve());
          });

          if (fs.existsSync(hookWav)) {
            // Duck the original for the hook's length + a short pad so dialogue
            // returns to full volume right after the hook finishes.
            let hookDur = 5;
            try {
              const hp = await execFileAsync("ffprobe", [
                "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", hookWav,
              ], { timeout: 10000 });
              hookDur = parseFloat(hp.stdout.trim()) || 5;
            } catch { /* default */ }
            const duckEnd = (hookDur + 0.6).toFixed(2);

            // Does the current file still have an audio stream to duck under the hook?
            let voiceHasAudio = false;
            try {
              const p = await execFileAsync("ffprobe", [
                "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
                "-of", "csv=p=0", finalOutputPath,
              ], { timeout: 10000 });
              voiceHasAudio = p.stdout.trim().length > 0;
            } catch { /* assume none */ }

            // Normalise both inputs to 48kHz stereo before amix (avoids sample-rate /
            // channel-layout mismatches between the aac source and the 22kHz mono hook),
            // sum without auto-attenuation (normalize=0), then loudnorm the result.
            const audioFilter = voiceHasAudio
              ? `[0:a]volume=enable='lt(t,${duckEnd})':volume=0.22,aresample=48000,aformat=channel_layouts=stereo[duck];` +
                `[1:a]adelay=300:all=1,aresample=48000,aformat=channel_layouts=stereo[hk];` +
                `[duck][hk]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`
              : `[1:a]adelay=300:all=1,aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`;

            const voicedPath = path.join(outputDir, `clip_${clipId}_voiced.mp4`);
            await spawnProcess("ffmpeg", [
              "-y", "-i", finalOutputPath, "-i", hookWav,
              "-filter_complex", audioFilter,
              "-map", "0:v", "-map", "[aout]",
              "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
              "-movflags", "+faststart",
              voicedPath,
            ], 300_000, () => {});

            if (fs.existsSync(voicedPath)) {
              fs.renameSync(voicedPath, finalOutputPath);
              logger.info({ finalOutputPath, hookDur }, "Intro-hook voiceover mixed in");
            }
            fs.existsSync(hookWav) && fs.unlinkSync(hookWav);
          } else {
            logger.warn("Voiceover WAV not produced — skipping hook mix");
          }
        }
      } catch (voErr) {
        logger.warn({ voErr }, "Voiceover generation failed (non-fatal)");
      }
    }
  } finally {
    // Clean up all temp files for this job (video segment + headline PNG).
    try {
      const tmpDir = os.tmpdir();
      const leftovers = fs
        .readdirSync(tmpDir)
        .filter((f) => f.includes(tmpId));
      for (const f of leftovers) {
        const p = path.join(tmpDir, f);
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          logger.info({ tmpFile: p }, "Cleaned up temp file");
        }
      }
    } catch (cleanupErr) {
      logger.warn({ cleanupErr, tmpId }, "Failed to clean up temp files");
    }
  }
}

// ============================================================================
// FEATURE 2 — MULTI-CLIP STORY MODE
// A story stitches 9-10 moments from ONE source into a single 60-120s video with
// bridging narration. Implemented WITHOUT touching processClip: each segment is
// composited by reusing processClip itself (clipId=0 → composite only, no per-
// segment captions/thumbnail/voiceover), then the segments are concatenated and
// the WHOLE stitched video is captioned + narrated by the two helpers below.
// The helpers are faithful copies of processClip's caption / narration steps so
// that the deployed single-clip path stays byte-for-byte unchanged.
// ============================================================================

export interface StorySegment {
  startTime: string;
  endTime: string;
  headline?: string;
  zoomMoments?: string;
  punchInEnabled?: boolean;
  // Match Story only: this beat's own source video + channel (multi-source montage).
  // Classic single-source Story leaves these blank and uses the job-level URL.
  youtubeUrl?: string;
  sourceChannel?: string;
  // Match Story only: this beat's own AI narration line. When present the beat is paced to
  // its voiceover and the line is placed at the beat's start (no flat timeline-guess script).
  narrationLine?: string;
  // Match Story only (P4 spoken-vs-caption split): the on-screen CAPTION text for this beat when it
  // must differ from what's spoken — narrationLine may be phonetic (for correct TTS pronunciation of
  // hard names), captionLine carries the correctly-spelled words to burn on screen. Same word count as
  // narrationLine so the karaoke re-spell aligns. Falls back to narrationLine when blank.
  captionLine?: string;
  // Match Story 2.0 only: a beat sourced from a LOCAL downloaded clip (scout) instead of a
  // YouTube URL. When set, the whole file is used (no yt-dlp, no timestamp verify) and the beat
  // is NOT window-extended past the clip's real length.
  localFile?: string;
  sourceType?: "youtube" | "local";

  // Story Mode 2.0 CUT ENGINE (all optional; a beat with none renders on the classic one-clip path,
  // so existing stories are byte-identical). Consumed by processMatchStory to rapid-cut the beat's
  // visuals at attention speed while the narration stays at story speed. See lib/cutEngine.ts.
  cutDensity?: { minSec: number; maxSec: number }; // seconds between filler cuts within the beat (jittered)
  fillerAssets?: string[];                          // uploads paths to rapid-cut TO between spoken words
  punchline?: { word: string; asset: string };      // asset lands on `word` (spoken in this beat), 150ms early
  holdMs?: number;                                   // readable content: suppress filler cuts for this long
}

// Pro-only: one ranked moment of a TOP 5 countdown (jobType "top5"). Superset of
// StorySegment — each moment carries its own `rank` (5→1), an optional per-moment
// source `youtubeUrl` (multi-source top-5s pull each rank from a different video;
// empty ⇒ single-source, the route fills it from the job URL), the `sourceChannel`
// for its "Credit:" line, and one spoken countdown `narrationLine` ("Number five: …").
export interface Top5Segment extends StorySegment {
  rank: number;
  youtubeUrl?: string;
  sourceChannel?: string;
  narrationLine?: string;
}

/**
 * Transcribes `filePath` with whisper.cpp and burns animated karaoke captions
 * into it in place. Faithful copy of processClip's caption step, run once over the
 * fully-stitched story. Non-fatal.
 */
async function burnCaptionsOnFile(
  clipId: number,
  filePath: string,
  duration: number,
  outroEnabled: boolean,
  captionColor: string,
  // Whisper transcribes THIS file instead of filePath when supplied. Match Story passes
  // an isolated AI-narration track so the captions read the voiceover, not the (muted)
  // source-clip commentary — captions still burn onto filePath.
  captionSourceOverride = "",
  // Match Story passes the EXACT spoken narration text here; the karaoke step re-spells
  // whisper's words to it (timing kept) so captions never carry an ASR typo.
  knownCaptionText = "",
  // Optional watermark @handle burned low-center on every frame (deters reposting).
  watermark = ""
): Promise<void> {
  const outputDir = getOutputDir();
  try {
    const srtPath = path.join(outputDir, `clip_${clipId}_captions.srt`);
    const transcriptPath = path.join(outputDir, `clip_${clipId}_transcript.txt`);
    const captionScript = path.join(os.homedir(), "myapp/scripts/generate_captions_pro.sh");
    const captionedPath = path.join(outputDir, `clip_${clipId}_captioned.mp4`);
    if (!fs.existsSync(captionScript)) return;
    const whisperInput = captionSourceOverride && fs.existsSync(captionSourceOverride) ? captionSourceOverride : filePath;

    const capResult = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const cap = spawn("bash", [captionScript, whisperInput, srtPath, transcriptPath], { timeout: 3_600_000 });
      let out = "";
      cap.stdout?.on("data", (d) => { out += d.toString(); });
      cap.on("close", (code) => resolve({ code, out }));
      cap.on("error", (err) => resolve({ code: -1, out: String(err) }));
    });
    if (capResult.code !== 0 || /\bFAIL\b/.test(capResult.out)) {
      logger.warn({ clipId, exitCode: capResult.code, tail: capResult.out.slice(-400) }, "Story caption script failed — may be uncaptioned");
    }

    if (fs.existsSync(transcriptPath)) {
      try {
        const transcript = fs.readFileSync(transcriptPath, "utf8").trim();
        if (transcript) await db.update(clipsTable).set({ transcript }).where(eq(clipsTable.id, clipId));
      } catch { /* non-fatal */ }
      fs.unlinkSync(transcriptPath);
    }

    if (fs.existsSync(srtPath)) {
      const assPath = path.join(outputDir, `clip_${clipId}_captions.ass`);
      const dtwJsonPath = srtPath.replace(/\.srt$/, ".json");
      const karaokeScript = path.join(os.homedir(), "myapp/scripts/karaoke_captions_pro.py");
      // Match Story: hand the exact spoken script to the karaoke step so it re-spells
      // whisper's words (timing untouched) — zero ASR typos on screen.
      let knownTextPath = "";
      if (knownCaptionText && knownCaptionText.trim()) {
        knownTextPath = path.join(outputDir, `clip_${clipId}_known.txt`);
        try { fs.writeFileSync(knownTextPath, knownCaptionText); } catch { knownTextPath = ""; }
      }
      let subFilter = `subtitles=${srtPath}:fontsdir=${FONTS_DIR}:force_style='FontName=DejaVu Sans,FontSize=12,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=1,Bold=1,Alignment=2,MarginV=95'`;
      let haveAss = false;
      if (fs.existsSync(karaokeScript) && fs.existsSync(dtwJsonPath)) {
        try {
          const captionEnd = outroEnabled ? Math.max(0, duration - 2) : duration;
          const karaokeArgs = [karaokeScript, dtwJsonPath, assPath, String(captionEnd), captionColor || ""];
          if (knownTextPath) karaokeArgs.push(knownTextPath);
          await execFileAsync(findPython(), karaokeArgs, { timeout: 30000 });
          if (fs.existsSync(assPath) && fs.readFileSync(assPath, "utf8").includes("Dialogue:")) {
            subFilter = `subtitles=${assPath}:fontsdir=${FONTS_DIR}`;
            haveAss = true;
          }
        } catch (kErr) {
          logger.warn({ kErr }, "Story karaoke caption generation failed — falling back to plain SRT");
        }
      }
      const srtHasContent = (() => { try { return fs.readFileSync(srtPath, "utf8").trim().length > 0; } catch { return false; } })();
      // Watermark: light @handle low-center on every frame (deters reposting), drawn in the SAME
      // re-encode as the captions. Whichever filter(s) exist run in one pass.
      const wmFilter = watermark
        ? `drawtext=fontfile='${ANTON_FONT}':text='${escapeDrawtext(watermark)}':fontsize=62:fontcolor=white@0.42:x=(w-text_w)/2:y=h*0.80:shadowx=2:shadowy=2:shadowcolor=black@0.4`
        : "";
      const capFilter = (haveAss || srtHasContent) ? subFilter : "";
      const vf = [capFilter, wmFilter].filter(Boolean).join(",");
      if (vf) {
        await spawnProcess("ffmpeg", [
          "-y", "-i", filePath, "-vf", vf,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-threads", "1",
          "-c:a", "copy", captionedPath,
        ], 0, () => {}, RENDER_STALL_MS, "render");
        if (fs.existsSync(captionedPath)) {
          fs.renameSync(captionedPath, filePath);
          logger.info({ filePath, mode: haveAss ? "dtw-karaoke" : (capFilter ? "srt" : "watermark-only"), watermark: !!watermark }, "Captions/watermark burned in");
        }
      } else {
        logger.info({ clipId }, "No captions or watermark — skipping burn");
      }
      fs.existsSync(srtPath) && fs.unlinkSync(srtPath);
      fs.existsSync(assPath) && fs.unlinkSync(assPath);
      fs.existsSync(dtwJsonPath) && fs.unlinkSync(dtwJsonPath);
      if (knownTextPath) { try { fs.existsSync(knownTextPath) && fs.unlinkSync(knownTextPath); } catch { /* ignore */ } }
    }
  } catch (capErr) {
    logger.warn({ capErr }, "Story caption generation failed (non-fatal)");
  }
}

/**
 * Mixes the bridging narration across the fully-stitched story timeline in place.
 * Faithful copy of processClip's narration step; timestamps are on the STITCHED
 * timeline (0 = start of the whole story). Non-fatal.
 */
async function mixNarrationOnFile(
  clipId: number,
  filePath: string,
  duration: number,
  outroEnabled: boolean,
  narrationScript: string,
  voice: string,
  speed: string,
  // How far to duck the original footage (0-1). In the hard-gate paths (Story / Top 5) this is
  // the level WHILE a narration line plays; outside spoken windows the footage returns to full.
  // In the smoothDuck path (Match Story) it is a CONSTANT floor the footage is held at across the
  // whole video, so a clip's own loud commentary can never fight the AI voice — Match Story passes
  // ~0.06 (a faint ambience bed), Top 5 uses 0.05, Story keeps the gentler 0.22 gate.
  duckVolume = 0.22,
  // Max narration lines to keep. Story/Top 5 use the default 8; Match Story raises it for
  // dense play-by-play. Threaded into parseNarrationLines' cap.
  maxLines = 8,
  // When set, also write an isolated narration-only WAV here (the AI voice at its real
  // timeline positions, silence elsewhere) so captions can be transcribed from the voice.
  emitNarrationTrackPath = "",
  // Match Story: duck the footage with a sidechain COMPRESSOR keyed by the voice (attack/
  // release give smooth fades) instead of the hard volume gate, so there's no abrupt jump
  // in/out of each line. Ignored when the footage has no audio.
  smoothDuck = false,
  // Match Story: reuse the per-beat WAVs already rendered in the beat loop instead of regenerating
  // from the "sec | line" script — kills the WAV-length mismatch that left multi-second silence gaps,
  // and halves Piper time. Each entry places its WAV at `sec` on the stitched timeline.
  preRendered: { sec: number; wav: string }[] = [],
  // Match Story mutes its footage, so the bed is SILENT — skip the sidechain duck (it only pumps on
  // silence, the "echo") and mix the voice cleanly.
  mutedBed = false
): Promise<void> {
  const outputDir = getOutputDir();
  try {
    const wavPaths: string[] = [];
    const spoken: { start: number; end: number }[] = [];
    if (preRendered.length) {
      for (const pr of preRendered) {
        if (!fs.existsSync(pr.wav)) continue;
        const wdur = (await probeContentDuration(pr.wav)) || 3;
        wavPaths.push(pr.wav);
        spoken.push({ start: pr.sec, end: pr.sec + wdur + 0.4 });
      }
    } else {
      const lines = parseNarrationLines(narrationScript, duration, outroEnabled, maxLines);
      for (const [i, ln] of lines.entries()) {
        const wav = path.join(outputDir, `clip_${clipId}_snarr_${i}.wav`);
        if (!(await generateNarrationWav(ln.text, wav, voice, speed))) {
          logger.warn({ clipId, line: i }, "Story narration WAV not produced — skipping line");
          continue;
        }
        const wdur = (await probeContentDuration(wav)) || 3;
        wavPaths.push(wav);
        spoken.push({ start: ln.sec, end: ln.sec + wdur + 0.4 });
      }
    }
    if (spoken.length > 0) {
      let narrHasAudio = false;
      try {
        const p = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", filePath], { timeout: 10000 });
        narrHasAudio = p.stdout.trim().length > 0;
      } catch { /* assume none */ }
      const ffInputs: string[] = ["-y", "-i", filePath];
      for (const w of wavPaths) ffInputs.push("-i", w);
      const anullIdx = 1 + wavPaths.length;
      if (!narrHasAudio || mutedBed) ffInputs.push("-f", "lavfi", "-t", String(duration), "-i", "anullsrc=r=48000:cl=stereo");
      const parts: string[] = [];
      // Delayed narration inputs [n1..nK] — shared by every ducking path.
      const narrLabels: string[] = [];
      wavPaths.forEach((_w, i) => {
        const inIdx = i + 1;
        const delayMs = Math.round(spoken[i]!.start * 1000);
        parts.push(`[${inIdx}:a]adelay=${delayMs}:all=1,aresample=48000,aformat=channel_layouts=stereo[n${inIdx}]`);
        narrLabels.push(`[n${inIdx}]`);
      });
      if (narrHasAudio && smoothDuck && !mutedBed) {
        // Smooth sidechain duck: sum the voice into one key, compress the footage by it
        // (attack/release act as fades), then mix the voice back over the ducked footage.
        // NB: duration=LONGEST — with duration=first the sum would be truncated to the first
        // (earliest, ~3s) line and every later line would be cut off. Then apad to the FULL
        // footage length: sidechaincompress ends when its key ends, so a short key would clip
        // the footage-audio tail after the last line. amix needs >=2 inputs, so a single line
        // is padded directly.
        if (narrLabels.length === 1) {
          parts.push(`${narrLabels[0]}apad=whole_dur=${duration}[narrsum]`);
        } else {
          parts.push(`${narrLabels.join("")}amix=inputs=${narrLabels.length}:duration=longest:normalize=0,apad=whole_dur=${duration}[narrsum]`);
        }
        parts.push(`[narrsum]asplit=2[nkey][nmix]`);
        // Hold the footage at a faint CONSTANT floor (duckVolume) so its own commentary never
        // competes with the narration, THEN sidechain-duck it further under each spoken line.
        parts.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=${duckVolume}[foot]`);
        parts.push(`[foot][nkey]sidechaincompress=threshold=0.02:ratio=20:attack=5:release=260:makeup=1[duckfoot]`);
        parts.push(`[duckfoot][nmix]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);
      } else if (mutedBed) {
        // Muted footage bed (Match Story): mix the voice over pure silence — NO sidechain (nothing to
        // duck) and NO dynamic loudnorm (it pumps/breathes across the silence between lines = the
        // reported "echo"). A gentle fixed boost + peak limiter keeps a clean, consistent 48kHz level.
        const mixLabels: string[] = [`[${anullIdx}:a]`, ...narrLabels];
        parts.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:normalize=0,volume=1.7,alimiter=limit=0.95,aresample=48000,aformat=channel_layouts=stereo[aout]`);
      } else {
        // Hard-gate duck (Story / Top 5): footage drops to duckVolume only inside each window.
        if (narrHasAudio) {
          const enableExpr = spoken.map((s) => `between(t,${s.start.toFixed(2)},${s.end.toFixed(2)})`).join("+");
          parts.push(`[0:a]volume=enable='${enableExpr}':volume=${duckVolume},aresample=48000,aformat=channel_layouts=stereo[base]`);
        } else {
          parts.push(`[${anullIdx}:a]aresample=48000,aformat=channel_layouts=stereo[base]`);
        }
        const mixLabels: string[] = ["[base]", ...narrLabels];
        parts.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);
      }
      const narratedPath = path.join(outputDir, `clip_${clipId}_snarrated.mp4`);
      await spawnProcess("ffmpeg", [
        ...ffInputs, "-filter_complex", parts.join(";"),
        "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart",
        narratedPath,
      ], 300_000, () => {});
      if (fs.existsSync(narratedPath)) {
        fs.renameSync(narratedPath, filePath);
        logger.info({ filePath, lines: spoken.length }, "Story bridging narration mixed in");
      }

      // Optional: an isolated narration-only track for caption transcription. Same delays
      // as the mix above but over pure silence (no footage audio), so whisper reads only
      // the AI voice and DTW word onsets line up with the spoken timeline.
      if (emitNarrationTrackPath) {
        const ntInputs: string[] = ["-y", "-f", "lavfi", "-t", String(duration), "-i", "anullsrc=r=48000:cl=stereo"];
        for (const w of wavPaths) ntInputs.push("-i", w);
        const ntParts: string[] = [];
        const ntLabels: string[] = ["[0:a]"];
        wavPaths.forEach((_w, i) => {
          const inIdx = i + 1;
          const delayMs = Math.round(spoken[i]!.start * 1000);
          ntParts.push(`[${inIdx}:a]adelay=${delayMs}:all=1,aresample=48000,aformat=channel_layouts=stereo[m${inIdx}]`);
          ntLabels.push(`[m${inIdx}]`);
        });
        ntParts.push(`${ntLabels.join("")}amix=inputs=${ntLabels.length}:duration=first:normalize=0[na]`);
        await spawnProcess("ffmpeg", [
          ...ntInputs, "-filter_complex", ntParts.join(";"),
          "-map", "[na]", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", emitNarrationTrackPath,
        ], 300_000, () => {});
      }
    } else {
      logger.warn({ clipId }, "No story narration lines produced — skipping");
    }
    for (const w of wavPaths) { try { fs.existsSync(w) && fs.unlinkSync(w); } catch { /* ignore */ } }
  } catch (naErr) {
    logger.warn({ naErr }, "Story narration generation failed (non-fatal)");
  }
}

/**
 * Renders a multi-clip STORY: composites each segment (via processClip, composite-
 * only), concatenates them, then captions + narrates the whole. One queue job, one
 * output file. Sequential segment rendering keeps the phone's memory flat.
 */
export async function processStory(
  youtubeUrl: string,
  outputFilename: string,
  channelHandle: string,
  clipId: number,
  frameStyle: "standard" | "immersive",
  sourceChannel: string,
  captionsEnabled: boolean,
  outroEnabled: boolean,
  captionColor: string,
  narrationScript: string,
  segments: StorySegment[],
  voiceOpts: VoiceOpts = {}
): Promise<void> {
  const outputDir = getOutputDir();
  const finalOutputPath = path.join(outputDir, outputFilename);
  const updateProgress = makeProgressUpdater(clipId);
  const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const storyVoice = resolveVoice(voiceOpts.voice, "story");
  const storySpeed = resolveSpeed(voiceOpts.speed);

  const segs = (segments ?? []).slice(0, 10);
  if (segs.length < 2) throw new Error("A story needs at least 2 segments.");

  // Cloud offload: download every segment locally (home IP) then render the whole story on
  // the cloud worker. Falls through to local rendering on any failure.
  if (process.env.CLOUD_RENDER_URL) {
    const ok = await tryCloudMultiSegment("story", clipId, finalOutputPath, {
      youtubeUrl, channelHandle, frameStyle, sourceChannel, captionsEnabled, outroEnabled,
      captionColor, narrationScript, voiceOpts: { voice: storyVoice, speed: storySpeed },
    }, segs, youtubeUrl, (p) => { void updateProgress(p); });
    if (ok) {
      logger.info({ finalOutputPath }, "Story rendered on cloud worker (offloaded)");
      await updateProgress(100, true);
      return;
    }
  }

  const segFiles: string[] = [];
  try {
    await updateProgress(2, true);

    // 1) Composite each segment sequentially (memory-safe). Reuse processClip with
    //    clipId=0 so it produces ONLY the composite (no per-segment captions/thumb/
    //    voiceover). The outro card is rendered on the LAST segment so it lands at the
    //    very end of the stitched story.
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const isLast = i === segs.length - 1;
      const segFilename = `story_${clipId}_seg_${i}_${tmpId}.mp4`;
      logger.info({ clipId, segment: i + 1, of: segs.length }, "Rendering story segment");
      // Per-beat handle is BLANK on purpose — see the watermark note on processClip's
      // channelHandle drawtext. This mode finishes with burnCaptionsOnFile(WATERMARK_HANDLE),
      // so passing the handle here too would stamp the clip twice.
      await processClip(
        seg.localFile ? null : youtubeUrl, seg.startTime, seg.endTime, seg.headline ?? "",
        segFilename, "edited", "", 0, seg.localFile || undefined, frameStyle, sourceChannel,
        false, isLast && outroEnabled, false, "",
        seg.punchInEnabled ?? false, seg.zoomMoments ?? "", "", "hook", ""
      );
      segFiles.push(path.join(outputDir, segFilename));
      await updateProgress(5 + ((i + 1) / segs.length) * 60, true);
    }

    // 2) Concat via the demuxer with -c copy. Every segment came from the same source
    //    and was composited with identical encode settings, so the streams are
    //    concatenatable without a re-encode. (The later caption pass re-encodes video
    //    and the narration pass re-encodes audio, cleaning up any seam timestamps.)
    const listPath = path.join(outputDir, `story_${clipId}_list_${tmpId}.txt`);
    fs.writeFileSync(listPath, segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    const stitchedPath = path.join(outputDir, `story_${clipId}_stitched_${tmpId}.mp4`);
    await spawnProcess("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-c", "copy", "-movflags", "+faststart", stitchedPath,
    ], 0, () => {}, RENDER_STALL_MS, "render");
    if (!fs.existsSync(stitchedPath)) throw new Error("Story concat produced no output");
    fs.renameSync(stitchedPath, finalOutputPath);
    await updateProgress(72, true);

    const storyDuration = (await probeContentDuration(finalOutputPath)) || 0;
    logger.info({ clipId, storyDuration, segments: segs.length }, "Story stitched");

    // 3) Thumbnail (non-fatal)
    try {
      const thumbPath = path.join(outputDir, `clip_${clipId}_thumb.jpg`);
      await spawnProcess("ffmpeg", ["-y", "-i", finalOutputPath, "-vf", "thumbnail=300", "-frames:v", "1", thumbPath], 60000, () => {});
    } catch (thumbErr) {
      logger.warn({ thumbErr }, "Story thumbnail failed (non-fatal)");
    }

    // 4) Bridging narration FIRST — mix the AI voice in and emit an ISOLATED voice-only
    //    track so the captions can be transcribed from the voice (synced to it), not the
    //    footage commentary. Footage stays audible under the voice (0.22 duck, unchanged).
    let narrTrackPath = "";
    const hasNarration = !!(narrationScript && narrationScript.trim());
    if (hasNarration && storyDuration > 0) {
      narrTrackPath = path.join(outputDir, `story_${clipId}_narrtrack_${tmpId}.wav`);
      await mixNarrationOnFile(clipId, finalOutputPath, storyDuration, outroEnabled, narrationScript, storyVoice, storySpeed, 0.22, 8, narrTrackPath, false);
      if (!fs.existsSync(narrTrackPath)) narrTrackPath = "";
    }
    await updateProgress(88, true);

    // 5) Captions. With narration, transcribe the AI-voice track so every caption word
    //    matches the voice and lands on its onset (DTW karaoke); the known script kills ASR
    //    typos. With no narration, fall back to captioning the footage audio (as before).
    if (captionsEnabled && storyDuration > 0) {
      const knownCaptionText = narrTrackPath
        ? parseNarrationLines(narrationScript, storyDuration, outroEnabled, 8).map((l) => l.text).join(" ")
        : "";
      await burnCaptionsOnFile(clipId, finalOutputPath, storyDuration, outroEnabled, captionColor, narrTrackPath, knownCaptionText, WATERMARK_HANDLE);
    }
    try { narrTrackPath && fs.existsSync(narrTrackPath) && fs.unlinkSync(narrTrackPath); } catch { /* ignore */ }
    await updateProgress(99, true);
    logger.info({ finalOutputPath }, "Story processing complete");
  } finally {
    // Clean up the per-segment files + list + any leftover story temp files.
    try {
      for (const f of segFiles) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch { /* ignore */ } }
      const leftovers = fs.readdirSync(outputDir).filter((f) => f.includes(tmpId));
      for (const f of leftovers) {
        const p = path.join(outputDir, f);
        try { fs.existsSync(p) && fs.unlinkSync(p); } catch { /* ignore */ }
      }
    } catch (cleanupErr) {
      logger.warn({ cleanupErr, tmpId }, "Failed to clean up story temp files");
    }
  }
}

/**
 * Re-encodes one composited part to the canonical Match Story params (1080x1920 canvas
 * comes from processClip; here we force fps 30 + yuv420p + aac 48k stereo). Parts of a
 * Match Story come from DIFFERENT source videos, so processClip may emit them at
 * different fps (it preserves the source's — 60 vs 30). Normalizing every part lets the
 * final concat stay a plain stream copy. Same idea as the Top 5 badge pass, minus the badge.
 */
async function canonicalizePart(inPath: string, outPath: string): Promise<void> {
  await spawnProcess("ffmpeg", [
    "-y", "-i", inPath,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", outPath,
  ], 0, () => {}, RENDER_STALL_MS, "render");
}

/**
 * Match Story intro card: a black 1080x1920 canvas with the job title wrapped + centered,
 * encoded to the SAME canonical params as the beats so it concats / crossfades cleanly.
 * Silent audio track (anullsrc) so the timeline has a stream to crossfade against.
 */
async function renderMatchTitleCard(title: string, outPath: string, dur: number): Promise<void> {
  const canvasW = 1080, canvasH = 1920, fps = 30;
  const font = findFont();
  const lines = wrapText(title.toUpperCase(), 16).slice(0, 4);
  const startY = Math.round(canvasH / 2 - (lines.length * 118) / 2 - 30);
  const draw = lines
    .map((ln, i) => `drawtext=fontfile='${font}':text='${escapeDrawtext(ln)}':fontsize=96:fontcolor=white:borderw=7:bordercolor=black:x=(w-text_w)/2:y=${startY + i * 118}`)
    .join(",");
  await spawnProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `color=c=black:s=${canvasW}x${canvasH}:d=${dur}:r=${fps}`,
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-vf", draw, "-t", String(dur),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(fps),
    "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", outPath,
  ], 0, () => {}, RENDER_STALL_MS, "render");
}

/**
 * Stitches the ordered parts with a short crossfade (xfade video + acrossfade audio) at each
 * seam. `partDurs` are each part's exact durations (same order) — needed to place every xfade
 * `offset`. Total output = sum(durs) - (n-1)*fade. Returns false (and cleans up) on any failure
 * so the caller can fall back to a plain stream-copy concat. One re-encode pass at the end.
 */
async function stitchWithTransitions(parts: string[], partDurs: number[], fade: number, outPath: string): Promise<boolean> {
  try {
    if (parts.length < 2) return false;
    const inputs: string[] = ["-y"];
    for (const p of parts) inputs.push("-i", p);
    const vfilters: string[] = [];
    const afilters: string[] = [];
    let vprev = "0:v";
    let aprev = "0:a";
    let cum = partDurs[0] ?? 0;
    for (let k = 1; k < parts.length; k++) {
      const offset = Math.max(0, cum - fade);
      const last = k === parts.length - 1;
      const vlabel = last ? "vout" : `vx${k}`;
      const alabel = last ? "aout" : `ax${k}`;
      vfilters.push(`[${vprev}][${k}:v]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}[${vlabel}]`);
      afilters.push(`[${aprev}][${k}:a]acrossfade=d=${fade}[${alabel}]`);
      vprev = vlabel;
      aprev = alabel;
      cum += (partDurs[k] ?? 0) - fade;
    }
    await spawnProcess("ffmpeg", [
      ...inputs, "-filter_complex", [...vfilters, ...afilters].join(";"),
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-r", "30",
      "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart", outPath,
    ], 0, () => {}, RENDER_STALL_MS, "render");
    return fs.existsSync(outPath) && ((await probeContentDuration(outPath)) || 0) > 0;
  } catch (e) {
    logger.warn({ e }, "Match Story crossfade stitch failed — falling back to plain concat");
    try { fs.existsSync(outPath) && fs.unlinkSync(outPath); } catch { /* ignore */ }
    return false;
  }
}

// ---- Story Mode 2.0 CUT ENGINE (filler cuts) ------------------------------------------------------

/**
 * Whisper-transcribe a beat's narration WAV into word onsets, via the SAME DTW-full pipeline the
 * captions use (generate_captions_pro.sh -> .json -> parseWhisperWords). Filler cuts land on these
 * real word gaps. Returns [] on any failure so the caller falls back to the un-cut beat.
 */
async function transcribeNarrationWords(wavPath: string, outputDir: string, tag: string): Promise<Word[]> {
  const captionScript = path.join(os.homedir(), "myapp/scripts/generate_captions_pro.sh");
  if (!fs.existsSync(captionScript) || !fs.existsSync(wavPath)) return [];
  const srtPath = path.join(outputDir, `cut_${tag}.srt`);
  const txtPath = path.join(outputDir, `cut_${tag}.txt`);
  const jsonPath = srtPath.replace(/\.srt$/, ".json");
  try {
    await new Promise<void>((resolve) => {
      const cap = spawn("bash", [captionScript, wavPath, srtPath, txtPath], { timeout: 600_000 });
      cap.on("close", () => resolve());
      cap.on("error", () => resolve());
    });
    if (!fs.existsSync(jsonPath)) return [];
    return parseWhisperWords(JSON.parse(fs.readFileSync(jsonPath, "utf8")));
  } catch (e) {
    logger.warn({ e, tag }, "Cut-engine narration transcription failed");
    return [];
  } finally {
    for (const f of [srtPath, txtPath, jsonPath]) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch { /* ignore */ } }
  }
}

/**
 * Canonicalize one cut asset (a filler or the punchline) to 1080x1920/30fps + a silent audio track.
 * Images are looped. Returns { path, dur, isImg } or null on failure.
 */
async function canonicalizeCutAsset(src: string, outF: string, D: number): Promise<{ path: string; dur: number; isImg: boolean } | null> {
  if (!fs.existsSync(src)) return null;
  const isImg = /\.(jpe?g|png|webp|gif|bmp)$/i.test(src);
  const cap = Math.max(2, Math.min(20, Math.ceil(D)));
  const inArgs = isImg ? ["-loop", "1", "-t", String(cap), "-i", src] : ["-i", src];
  const SCALE = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30";
  try {
    await spawnProcess("ffmpeg", [
      "-y", ...inArgs, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      "-map", "0:v:0", "-map", "1:a", "-vf", SCALE, "-t", String(isImg ? cap : 20),
      "-c:v", "libx264", "-preset", "veryfast", "-threads", "1", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-shortest", "-movflags", "+faststart", outF,
    ], 0, () => {}, RENDER_STALL_MS, "render");
    const dur = (await probeContentDuration(outF)) || 0;
    return dur > 0.3 ? { path: outF, dur, isImg } : null;
  } catch (e) {
    logger.warn({ e, src }, "Cut-engine asset canonicalize failed");
    return null;
  }
}

/**
 * Subdivide ONE beat into rapid FILLER cuts. Takes the beat's canonical composited video
 * (`baseCanon`, 1080x1920/30fps, `D` seconds) and, on the narration word gaps (jittered per
 * `density`), cuts away to curated `fillerPaths` and back — so the picture moves at attention speed
 * while the beat's DURATION is preserved exactly (narration placement + captions downstream are
 * untouched). One encode pass at -preset veryfast -threads 1, no heap bump. Returns the subdivided
 * path, or null (no words / no cuts / any failure) so the caller keeps the un-cut beat.
 */
async function renderBeatWithFillerCuts(
  baseCanon: string,
  fillerPaths: string[],
  narrationWav: string,
  density: { minSec: number; maxSec: number },
  holdMsBeat: number,
  punchline: { word: string; asset: string } | undefined,
  D: number,
  ctx: { outputDir: string; clipId: number; tmpId: string; i: number },
): Promise<string | null> {
  const { outputDir, clipId, tmpId, i } = ctx;
  if (D <= 0.5 || fillerPaths.length === 0) return null;

  const words = await transcribeNarrationWords(narrationWav, outputDir, `${clipId}_${i}_${tmpId}`);
  if (words.length === 0) return null;
  // Duration floor #1: if the beat opens on something to READ (holdMsBeat), suppress filler cuts for
  // that long so the viewer is never cut away mid-read.
  const beatHolds = holdMsBeat > 0 ? [{ start: 0, end: Math.min(D, holdMsBeat / 1000) }] : [];
  const cuts = planFillerCuts(words, 0, D, density, beatHolds)
    .filter((c) => c > 0.15 && c < D - 0.15)
    .slice(0, 80); // safety cap on filtergraph size
  if (cuts.length === 0) return null;

  // Canonicalize each filler once (1080x1920/30fps + silent audio).
  const tmpFiles: string[] = [];
  const fillerCanon: { path: string; dur: number; isImg: boolean }[] = [];
  for (let f = 0; f < fillerPaths.length; f++) {
    const outF = path.join(outputDir, `cutfill_${clipId}_${i}_${f}_${tmpId}.mp4`);
    const c = await canonicalizeCutAsset(fillerPaths[f]!, outF, D);
    if (c) { fillerCanon.push(c); tmpFiles.push(outF); }
    else { try { fs.existsSync(outF) && fs.unlinkSync(outF); } catch { /* ignore */ } }
  }
  if (fillerCanon.length === 0) return null;

  // Punchline (optional): land the punch asset on ONE spoken word, 150ms early. Its input sits AFTER
  // the fillers and appears ONLY in its forced window — never in the base/filler rotation.
  let punchCanon: { path: string; dur: number; isImg: boolean } | null = null;
  let punchAt = -1;
  if (punchline && punchline.word && punchline.asset) {
    const pt = findWordTime(words, punchline.word, 0.15);
    if (pt !== null && pt > 0.2 && pt < D - 0.3) {
      const outP = path.join(outputDir, `cutpunch_${clipId}_${i}_${tmpId}.mp4`);
      punchCanon = await canonicalizeCutAsset(punchline.asset, outP, D);
      if (punchCanon) { tmpFiles.push(outP); punchAt = pt; }
    }
  }
  const punchInputIdx = punchCanon ? 1 + fillerCanon.length : -1;
  // input index -> its canonical clip (fillers are 1..K, punch is K+1); base (0) is the beat itself.
  const canonByInput = new Map<number, { path: string; dur: number; isImg: boolean }>();
  fillerCanon.forEach((fc, j) => canonByInput.set(j + 1, fc));
  if (punchCanon) canonByInput.set(punchInputIdx, punchCanon);

  // Interval plan (timeline coords first). Base + fillers rotate; the punch window is FORCED to the
  // punch asset and kept a single uninterrupted interval (filler cuts inside it are dropped).
  const PUNCH_HOLD = 1.3;
  const punchEnd = punchAt >= 0 ? Math.min(D, punchAt + Math.min(PUNCH_HOLD, D - punchAt)) : -1;
  const cutsForBounds = punchAt >= 0 ? cuts.filter((c) => c <= punchAt + 1e-6 || c >= punchEnd - 1e-6) : cuts;
  const boundSet = new Set<number>([0, D, ...cutsForBounds]);
  if (punchAt >= 0) { boundSet.add(punchAt); boundSet.add(punchEnd); }
  const bounds = Array.from(boundSet).filter((x) => x >= 0 && x <= D).sort((a, b) => a - b);
  const rotation: number[] = [0, ...fillerCanon.map((_, j) => j + 1)]; // 0 = base; j+1 = filler (punch excluded)
  type Seg = { input: number; tStart: number; tEnd: number };
  const raw: Seg[] = [];
  let rotIdx = 0;
  for (let k = 0; k + 1 < bounds.length; k++) {
    const tStart = bounds[k]!, tEnd = bounds[k + 1]!;
    if (tEnd - tStart <= 0.05) continue;
    if (punchAt >= 0 && Math.abs(tStart - punchAt) < 1e-6) {
      raw.push({ input: punchInputIdx, tStart, tEnd }); // forced punch window (outside the rotation)
    } else {
      raw.push({ input: rotation[rotIdx % rotation.length]!, tStart, tEnd });
      rotIdx++;
    }
  }
  // Duration floor #2: an image filler is a readable hold — never cut away from it before
  // IMAGE_HOLD_SEC; absorb the following intervals that would have cut mid-read. (Punch is pre-sized.)
  const IMAGE_HOLD_SEC = 1.4;
  const merged: Seg[] = [];
  for (let k = 0; k < raw.length; k++) {
    const cur: Seg = { ...raw[k]! };
    const c = canonByInput.get(cur.input);
    if (cur.input !== punchInputIdx && c && c.isImg) {
      while (k + 1 < raw.length && cur.tEnd - cur.tStart < IMAGE_HOLD_SEC) cur.tEnd = raw[++k]!.tEnd;
    }
    merged.push(cur);
  }
  if (merged.length < 2) return null;

  // Convert to per-input trim windows (base = real timeline; filler/punch = rolling offset in the clip).
  const plan: { input: number; a: number; b: number }[] = merged.map((s) => {
    const L = s.tEnd - s.tStart;
    if (s.input === 0) return { input: 0, a: s.tStart, b: s.tEnd };
    const c = canonByInput.get(s.input)!;
    const room = Math.max(0, c.dur - L);
    const off = room > 0.05 ? (s.tStart % room) : 0;
    return { input: s.input, a: off, b: off + L };
  });

  // An input pad can be consumed only ONCE, so split each used input into as many copies as needed.
  const usage = new Map<number, number>();
  for (const pl of plan) usage.set(pl.input, (usage.get(pl.input) ?? 0) + 1);
  const splitDecls: string[] = [];
  const splitLabels = new Map<number, string[]>();
  for (const [inp, cnt] of usage) {
    const labels = Array.from({ length: cnt }, (_, x) => `i${inp}s${x}`);
    splitDecls.push(`[${inp}:v]split=${cnt}${labels.map((l) => `[${l}]`).join("")}`);
    splitLabels.set(inp, labels);
  }
  const cursor = new Map<number, number>();
  const vsegs: string[] = [];
  const outLabels: string[] = [];
  plan.forEach((pl, k) => {
    const ci = cursor.get(pl.input) ?? 0;
    cursor.set(pl.input, ci + 1);
    const inLbl = splitLabels.get(pl.input)![ci]!;
    const outLbl = `v${k}`;
    vsegs.push(`[${inLbl}]trim=start=${pl.a.toFixed(3)}:end=${pl.b.toFixed(3)},setpts=PTS-STARTPTS,setsar=1[${outLbl}]`);
    outLabels.push(`[${outLbl}]`);
  });
  const filter = [...splitDecls, ...vsegs].join(";") + `;${outLabels.join("")}concat=n=${outLabels.length}:v=1:a=0[vcat]`;

  const inputs: string[] = ["-y", "-i", baseCanon];
  for (const fc of fillerCanon) inputs.push("-i", fc.path);
  if (punchCanon) inputs.push("-i", punchCanon.path);
  const anullIdx = 1 + fillerCanon.length + (punchCanon ? 1 : 0);
  inputs.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");

  const outPath = path.join(outputDir, `cutbeat_${clipId}_${i}_${tmpId}.mp4`);
  try {
    await spawnProcess("ffmpeg", [
      ...inputs, "-filter_complex", filter,
      "-map", "[vcat]", "-map", `${anullIdx}:a`, "-t", String(D),
      "-c:v", "libx264", "-preset", "veryfast", "-threads", "1", "-crf", "16", "-pix_fmt", "yuv420p", "-r", "30",
      "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", outPath,
    ], 0, () => {}, RENDER_STALL_MS, "render");
  } catch (e) {
    logger.warn({ e, beat: i + 1 }, "Cut-engine filler concat failed — using un-cut beat");
  } finally {
    for (const f of tmpFiles) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch { /* ignore */ } }
  }
  if (!fs.existsSync(outPath) || ((await probeContentDuration(outPath)) || 0) <= 0.3) {
    try { fs.existsSync(outPath) && fs.unlinkSync(outPath); } catch { /* ignore */ }
    return null;
  }
  return outPath;
}

/**
 * Renders a MATCH STORY (jobType "matchstory"): a research-driven, MULTI-SOURCE narrated
 * montage. Each beat is a StorySegment carrying its OWN youtubeUrl (different broadcast /
 * fan-cam / club angles) and — in the modern per-beat mode — its OWN `narrationLine`.
 *
 * Per-beat mode (the default now): each beat is PACED to its voiceover (the beat lasts as
 * long as its line so the voice always matches what's on screen), the montage opens on a
 * title card, seams are crossfaded, and the footage is smooth-ducked to silence under the
 * voice. The line is placed at the beat's real start on the stitched timeline — no guessed
 * timestamps. The legacy flat `narrationScript` path (no per-beat lines) still works and
 * keeps the old plain concat with no title/transitions so its hand-authored timestamps stay
 * valid. Like Top 5, every part is normalized to identical encode params so cross-source
 * stitching is clean.
 */
export async function processMatchStory(
  outputFilename: string,
  channelHandle: string,
  clipId: number,
  frameStyle: "standard" | "immersive",
  sourceChannel: string,
  captionsEnabled: boolean,
  outroEnabled: boolean,
  captionColor: string,
  narrationScript: string,
  segments: StorySegment[],
  voiceOpts: VoiceOpts = {},
  title = "",
  transitionsEnabled = true,
  // Intro title cards are OPT-IN. A black card in front of a Short is a scroll-killer — the
  // first frame must be footage. Never flip this default back to true.
  titleCardEnabled = false
): Promise<void> {
  const outputDir = getOutputDir();
  const finalOutputPath = path.join(outputDir, outputFilename);
  const updateProgress = makeProgressUpdater(clipId);
  const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const msVoice = resolveVoice(voiceOpts.voice, "matchstory");
  const msSpeed = resolveSpeed(voiceOpts.speed);

  const segs = (segments ?? []).slice(0, 8);
  if (segs.length < 2) throw new Error("A Match Story needs at least 2 beats.");

  const isLocalBeat = (s: StorySegment) => !!(s.localFile && s.localFile.trim());
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (isLocalBeat(s)) {
      if (!fs.existsSync(s.localFile!)) throw new Error(`Beat #${i + 1}: downloaded clip is missing — re-scout.`);
    } else if (!s.youtubeUrl || !s.youtubeUrl.trim()) {
      throw new Error(`Beat #${i + 1} is missing a source video URL.`);
    }
  }

  // FOOTAGE SHARPNESS — enforced HERE, at the renderer, not only at the sourcing step.
  //
  // Scout's /scout/fetch-urls gates clips as it downloads them, but that only covers beats
  // that arrived through Scout. A hand-built tar bundle POSTed to the cloud worker goes
  // straight to runBundledJob -> here, bypassing that gate entirely — which is exactly how
  // a 1920x1080-at-519kbps recap re-upload shipped as visibly soft B-roll. Checking at the
  // renderer means EVERY path (app route, connector, bundled cloud job) is covered by one
  // rule. Costs one ffprobe per beat and fails before any encoding starts.
  //
  // Overridable per job for topics with genuinely no sharp footage (0 disables a floor).
  const qOpts = {
    minShortSide: Number.isFinite(Number(process.env.MIN_BEAT_SHORT_SIDE)) ? Number(process.env.MIN_BEAT_SHORT_SIDE) : undefined,
    minBitsPerPixel: Number.isFinite(Number(process.env.MIN_BEAT_BITS_PER_PIXEL)) ? Number(process.env.MIN_BEAT_BITS_PER_PIXEL) : undefined,
  };
  const softBeats: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (!isLocalBeat(s)) continue; // YouTube beats are HD-floored at download time
    const verdict = judgeFootage(await probeFootage(s.localFile!), qOpts);
    if (!verdict.ok) softBeats.push(`Beat #${i + 1} (${path.basename(s.localFile!)}): ${verdict.reason}`);
  }
  if (softBeats.length) {
    throw new Error(
      `${softBeats.length} beat(s) failed the footage sharpness check, so the render was stopped before wasting an encode:\n`
      + softBeats.map((b) => `  • ${b}`).join("\n")
      + `\nReplace them with sharper sources (real broadcast footage, not AI-recap/re-upload channels). `
      + `To override for a topic that genuinely has no sharp footage, set MIN_BEAT_SHORT_SIDE / MIN_BEAT_BITS_PER_PIXEL (0 disables).`
    );
  }

  // Cloud offload: bundle every beat (local scout clips are copied as-is; YouTube beats are
  // downloaded on the home IP) and render the whole Match Story on the cloud. Falls through
  // to local on any failure.
  if (process.env.CLOUD_RENDER_URL) {
    const ok = await tryCloudMultiSegment("matchstory", clipId, finalOutputPath, {
      channelHandle, frameStyle, sourceChannel, captionsEnabled, outroEnabled, captionColor,
      narrationScript, voiceOpts: { voice: msVoice, speed: msSpeed }, title, transitionsEnabled, titleCardEnabled,
    }, segs, null, (p) => { void updateProgress(p); });
    if (ok) {
      logger.info({ finalOutputPath }, "Match Story rendered on cloud worker (offloaded)");
      await updateProgress(100, true);
      return;
    }
  }


  // Pre-flight every YouTube beat's window (durations are cached from the verify step) so a
  // hallucinated timestamp fails in seconds and names the exact beat, not after ~15 min. Local
  // (scout-downloaded) beats use the whole file, so there's nothing to validate.
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (isLocalBeat(s)) continue;
    const check = await validateSegmentWithinVideo(s.youtubeUrl!, s.startTime, s.endTime);
    if (!check.ok) throw new Error(`Beat #${i + 1}: ${check.message}`);
  }

  // Per-beat mode = any beat carries its own line. Gates pacing, the title card, and the
  // crossfades; legacy flat-script jobs stay on plain concat so their timestamps hold.
  const perBeat = segs.some((s) => (s.narrationLine ?? "").trim().length > 0);
  const wantTitle = titleCardEnabled && perBeat && !!title.trim();
  const fade = transitionsEnabled && perBeat ? 0.3 : 0;
  const TITLE_DUR = 2.6;

  const parts: string[] = [];
  const partDurs: number[] = [];
  // Per-beat voiceover captured during pacing (index-aligned to segs); reused for placement.
  const beatVo: ({ text: string; caption: string; wav: string; dur: number } | null)[] = segs.map(() => null);

  try {
    await updateProgress(2, true);

    // 0) Intro/title card (per-beat mode only) — becomes parts[0].
    if (wantTitle) {
      const titleCard = path.join(outputDir, `match_${clipId}_title_${tmpId}.mp4`);
      try {
        await renderMatchTitleCard(title.trim(), titleCard, TITLE_DUR);
        if (fs.existsSync(titleCard)) {
          parts.push(titleCard);
          partDurs.push((await probeContentDuration(titleCard)) || TITLE_DUR);
        }
      } catch (tErr) {
        logger.warn({ tErr }, "Match Story title card failed (non-fatal) — skipping");
      }
    }

    // 1) Composite each beat from its OWN source (processClip, composite-only). In per-beat
    //    mode we first synthesize the beat's voiceover, measure it, and stretch the beat's
    //    window to cover it (+lead/tail, +2s on the outro beat) so the voice never bleeds
    //    into the next beat. Then normalize the encode so cross-source parts stitch cleanly.
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const isLast = i === segs.length - 1;
      let endTime = seg.endTime;

      if (perBeat) {
        const line = (seg.narrationLine ?? "").trim();
        let voDur = 0;
        if (line) {
          const wav = path.join(outputDir, `match_${clipId}_vo_${i}_${tmpId}.wav`);
          if (await generateNarrationWav(line, wav, msVoice, msSpeed)) {
            voDur = (await probeContentDuration(wav)) || 0;
            // P4: the CAPTION shows captionLine (correct spelling) when given, else the spoken line.
            beatVo[i] = { text: line, caption: (seg.captionLine ?? "").trim() || line, wav, dur: voDur };
          }
        }
        const pad = 0.3 + 0.4 + (isLast && outroEnabled ? 1 : 0);
        if (isLocalBeat(seg)) {
          // Scout/local beats: TRIM the downloaded clip down to its narration line (B-roll cut to
          // fit) so the story is NARRATION-DRIVEN and tight — not the full clip (playing whole scout
          // clips made a 4-beat story run ~4 min). Capped at the real footage length (never
          // freeze-pad past it — a short clip padded to a long line reads as a frozen video) and
          // ≤ 24s so no single beat dominates. Script-first stories use ~25-word lines (~11s), so
          // the clip-finding brief tells Claude to pick clips at least as long as their line; when
          // a clip IS shorter, the beat is capped to the footage (its line may bleed a touch).
          const clipLen = Math.max(1, timeToSeconds(seg.endTime) - timeToSeconds(seg.startTime));
          const want = voDur > 0 ? voDur + pad : Math.min(clipLen, 8);
          const targetLen = Math.min(clipLen, 24, want);
          endTime = secondsToHMS(timeToSeconds(seg.startTime) + targetLen);
        } else {
          // YouTube beats: stretch the window to cover the voiceover (capped 24s).
          const reqLen = Math.max(0, timeToSeconds(seg.endTime) - timeToSeconds(seg.startTime));
          const targetLen = Math.min(24, Math.max(reqLen, voDur > 0 ? voDur + pad : reqLen));
          if (targetLen > reqLen + 0.05) endTime = secondsToHMS(timeToSeconds(seg.startTime) + targetLen);
        }
      }

      const rawFile = `match_${clipId}_seg_${i}_${tmpId}.mp4`;
      logger.info({ clipId, beat: i + 1, of: segs.length, local: isLocalBeat(seg) }, "Rendering Match Story beat");
      try {
        await processClip(
          isLocalBeat(seg) ? null : seg.youtubeUrl!, seg.startTime, endTime, seg.headline ?? "",
          rawFile, "edited", "", 0, isLocalBeat(seg) ? seg.localFile : undefined, frameStyle, seg.sourceChannel || sourceChannel,
          false, isLast && outroEnabled, false, "",
          seg.punchInEnabled ?? false, seg.zoomMoments ?? "", "", "hook", ""
        );
      } catch (err) {
        throw new Error(`Beat #${i + 1}: ${parseProcessingError(err instanceof Error ? err.message : String(err))}`);
      }
      const rawPath = path.join(outputDir, rawFile);
      if (!fs.existsSync(rawPath)) throw new Error(`Match Story: beat #${i + 1} produced no file`);

      const canonPath = path.join(outputDir, `match_${clipId}_canon_${i}_${tmpId}.mp4`);
      await canonicalizePart(rawPath, canonPath);
      try { fs.existsSync(rawPath) && fs.unlinkSync(rawPath); } catch { /* ignore */ }
      if (!fs.existsSync(canonPath)) throw new Error(`Match Story: normalize pass failed for beat #${i + 1}`);
      // Story Mode 2.0 cut engine: if this beat carries cut fields, subdivide it into rapid filler
      // cuts on the narration word gaps. Falls back to the un-cut beat on any failure — a beat with
      // no cutDensity/fillerAssets is completely untouched (existing stories render byte-identical).
      let beatPart = canonPath;
      const cutFillers = seg.fillerAssets ?? [];
      if (perBeat && seg.cutDensity && cutFillers.length > 0 && beatVo[i]?.wav) {
        const beatDur = (await probeContentDuration(canonPath)) || 0;
        const subdivided = await renderBeatWithFillerCuts(
          canonPath, cutFillers, beatVo[i]!.wav, seg.cutDensity, seg.holdMs ?? 0, seg.punchline, beatDur, { outputDir, clipId, tmpId, i },
        );
        if (subdivided && fs.existsSync(subdivided)) {
          try { fs.existsSync(canonPath) && fs.unlinkSync(canonPath); } catch { /* ignore */ }
          beatPart = subdivided;
          logger.info({ clipId, beat: i + 1, fillers: cutFillers.length }, "Beat subdivided with filler cuts");
        }
      }
      parts.push(beatPart);
      partDurs.push((await probeContentDuration(beatPart)) || 0);
      await updateProgress(5 + ((i + 1) / segs.length) * 58, true);
    }

    // 2) Stitch. Per-beat mode crossfades the seams (falls back to concat on any failure);
    //    legacy mode always plain-concats. usedFade feeds the narration offset math below.
    let usedFade = 0;
    const stitchedPath = path.join(outputDir, `match_${clipId}_stitched_${tmpId}.mp4`);
    if (fade > 0 && (await stitchWithTransitions(parts, partDurs, fade, stitchedPath))) {
      usedFade = fade;
    } else {
      const listPath = path.join(outputDir, `match_${clipId}_list_${tmpId}.txt`);
      fs.writeFileSync(listPath, parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
      await spawnProcess("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0", "-i", listPath,
        "-c", "copy", "-movflags", "+faststart", stitchedPath,
      ], 0, () => {}, RENDER_STALL_MS, "render");
    }
    if (!fs.existsSync(stitchedPath)) throw new Error("Match Story stitch produced no output");
    fs.renameSync(stitchedPath, finalOutputPath);
    await updateProgress(72, true);

    const totalDuration = (await probeContentDuration(finalOutputPath)) || 0;
    logger.info({ clipId, totalDuration, beats: segs.length, perBeat, usedFade }, "Match Story stitched");

    // 3) Thumbnail (non-fatal)
    try {
      const thumbPath = path.join(outputDir, `clip_${clipId}_thumb.jpg`);
      await spawnProcess("ffmpeg", ["-y", "-i", finalOutputPath, "-vf", "thumbnail=300", "-frames:v", "1", thumbPath], 60000, () => {});
    } catch (thumbErr) {
      logger.warn({ thumbErr }, "Match Story thumbnail failed (non-fatal)");
    }

    // 4) Narration. Per-beat mode builds the "sec | line" script from each beat's real START
    //    on the stitched (crossfade-shortened) timeline, so the voice lands on its own beat.
    //    Footage is smooth-ducked with a sidechain compressor (only the AI voice is heard).
    let effectiveNarration = narrationScript;
    const preRenderedWavs: { sec: number; wav: string }[] = [];
    if (perBeat) {
      const beatPartOffset = parts.length > segs.length ? 1 : 0; // title card occupies parts[0]
      const lines: string[] = [];
      for (let i = 0; i < segs.length; i++) {
        const vo = beatVo[i];
        if (!vo || !vo.text) continue;
        const partIdx = beatPartOffset + i;
        let startFinal = 0;
        for (let k = 0; k < partIdx; k++) startFinal += partDurs[k] ?? 0;
        startFinal -= partIdx * usedFade;
        // Land the line just after the beat is fully on screen (past the incoming crossfade).
        const sec = Math.max(0.3, startFinal + (partIdx > 0 ? usedFade : 0) + 0.3);
        lines.push(`${sec.toFixed(1)} | ${vo.text}`);
        if (vo.wav && fs.existsSync(vo.wav)) preRenderedWavs.push({ sec, wav: vo.wav });
      }
      effectiveNarration = lines.join("\n");
    }

    let narrTrackPath = "";
    if (effectiveNarration && effectiveNarration.trim() && totalDuration > 0) {
      narrTrackPath = path.join(outputDir, `match_${clipId}_narrtrack_${tmpId}.wav`);
      await mixNarrationOnFile(clipId, finalOutputPath, totalDuration, outroEnabled, effectiveNarration, msVoice, msSpeed, 0.06, 16, narrTrackPath, true, perBeat ? preRenderedWavs : [], perBeat);
      if (!fs.existsSync(narrTrackPath)) narrTrackPath = "";
    }
    await updateProgress(88, true);

    // 5) Captions transcribed from the AI narration track (not the muted footage), so
    //    every caption word matches the voice and lands on its onset via DTW karaoke. In
    //    per-beat mode we also hand over the exact script so captions carry zero ASR typos.
    if (captionsEnabled && totalDuration > 0) {
      const knownCaptionText = perBeat ? beatVo.filter((v) => v && v.caption).map((v) => v!.caption).join(" ") : "";
      await burnCaptionsOnFile(clipId, finalOutputPath, totalDuration, outroEnabled, captionColor, narrTrackPath, knownCaptionText, WATERMARK_HANDLE);
    }
    try { narrTrackPath && fs.existsSync(narrTrackPath) && fs.unlinkSync(narrTrackPath); } catch { /* ignore */ }
    await updateProgress(99, true);
    logger.info({ finalOutputPath }, "Match Story processing complete");
  } finally {
    try {
      for (const f of parts) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch { /* ignore */ } }
      const leftovers = fs.readdirSync(outputDir).filter((f) => f.includes(tmpId));
      for (const f of leftovers) {
        const p = path.join(outputDir, f);
        try { fs.existsSync(p) && fs.unlinkSync(p); } catch { /* ignore */ }
      }
    } catch (cleanupErr) {
      logger.warn({ cleanupErr, tmpId }, "Failed to clean up Match Story temp files");
    }
  }
}

/**
 * Renders a TOP 5 countdown: a title card, then each ranked moment composited (via
 * processClip, composite-only) with a #5→#1 rank badge burned on, all stitched into
 * one video, captioned once, then given a countdown voiceover ("Number five: …").
 *
 * Mirrors processStory's memory-safe sequential structure. Two differences from a
 * story: (a) each moment can come from its OWN source URL (multi-source), and (b) the
 * per-moment badge pass re-encodes every part to identical params (canvas/fps/pix_fmt/
 * audio), so parts from different sources still concat with a plain stream copy.
 */
export async function processTop5(
  outputFilename: string,
  title: string,
  channelHandle: string,
  clipId: number,
  frameStyle: "standard" | "immersive",
  sourceChannel: string,
  captionsEnabled: boolean,
  outroEnabled: boolean,
  captionColor: string,
  order: "5to1" | "1to5",
  segments: Top5Segment[],
  voiceOpts: VoiceOpts = {}
): Promise<void> {
  const outputDir = getOutputDir();
  const finalOutputPath = path.join(outputDir, outputFilename);
  const updateProgress = makeProgressUpdater(clipId);
  const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const top5Voice = resolveVoice(voiceOpts.voice, "top5");
  const top5Speed = resolveSpeed(voiceOpts.speed);

  // Play order: default 5→1 (best/most-agreed moment last, as the finale).
  const ordered = [...segments].sort((a, b) =>
    order === "1to5" ? a.rank - b.rank : b.rank - a.rank
  );
  if (ordered.length < 2) throw new Error("A Top 5 needs at least 2 moments.");

  // Cloud offload: download every moment locally (home IP) then render the whole Top 5 on the
  // cloud worker. Falls through to local rendering on any failure.
  if (process.env.CLOUD_RENDER_URL) {
    const ok = await tryCloudMultiSegment("top5", clipId, finalOutputPath, {
      title, channelHandle, frameStyle, sourceChannel, captionsEnabled, outroEnabled,
      captionColor, order, voiceOpts: { voice: top5Voice, speed: top5Speed },
    }, ordered, null, (p) => { void updateProgress(p); });
    if (ok) {
      logger.info({ finalOutputPath }, "Top 5 rendered on cloud worker (offloaded)");
      await updateProgress(100, true);
      return;
    }
  }

  for (const s of ordered) {
    if (!s.localFile && (!s.youtubeUrl || !s.youtubeUrl.trim())) {
      throw new Error(`Moment #${s.rank} is missing a source video URL.`);
    }
  }

  // Pre-flight: validate every moment's window before rendering anything. A hallucinated
  // timestamp then fails in seconds (durations are cached from the verify step) instead of
  // after ~15 min of composites, and the message names the exact moment so a Retry is targeted.
  for (const s of ordered) {
    if (s.localFile) continue;
    const check = await validateSegmentWithinVideo(s.youtubeUrl!, s.startTime, s.endTime);
    if (!check.ok) throw new Error(`Moment #${s.rank}: ${check.message}`);
  }

  const canvasW = 1080, canvasH = 1920, fps = 30;
  const font = findFont();
  const titleDur = 2.6;

  // parts[0] = title card; parts[i+1] = badged moment file for ordered[i]. Kept in
  // play order so the concat list and the voiceover timeline line up.
  const parts: string[] = [];
  try {
    await updateProgress(2, true);

    // 1) Title card — black canvas, "TOP 5" over the wrapped topic, silent audio.
    //    Encoded to the SAME params as the moment parts so the concat seam is clean.
    {
      const subLines = wrapText(title.toUpperCase(), 18).slice(0, 3);
      const draw = [
        `drawtext=fontfile='${font}':text='TOP 5':fontsize=210:fontcolor=white:borderw=8:bordercolor=black:x=(w-text_w)/2:y=560`,
        ...subLines.map((ln, i) =>
          `drawtext=fontfile='${font}':text='${escapeDrawtext(ln)}':fontsize=78:fontcolor=0xF5C518:borderw=5:bordercolor=black:x=(w-text_w)/2:y=${880 + i * 98}`
        ),
      ].join(",");
      const titleCard = path.join(outputDir, `top5_${clipId}_title_${tmpId}.mp4`);
      await spawnProcess("ffmpeg", [
        "-y",
        "-f", "lavfi", "-i", `color=c=black:s=${canvasW}x${canvasH}:d=${titleDur}:r=${fps}`,
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-vf", draw, "-t", String(titleDur),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", "-r", String(fps),
        "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", titleCard,
      ], 0, () => {}, RENDER_STALL_MS, "render");
      if (!fs.existsSync(titleCard)) throw new Error("Top 5: title card render failed");
      parts.push(titleCard);
    }
    await updateProgress(6, true);

    // 2) Each moment: composite via processClip (clipId=0 → composite only, captions
    //    off; captions run once at the end). The outro/subscribe card rides the LAST
    //    played moment. The "#N" rank number is already burned above the title inside the
    //    composite; this pass just normalizes the encode params for a clean stream-copy concat.
    for (let i = 0; i < ordered.length; i++) {
      const seg = ordered[i]!;
      const isLast = i === ordered.length - 1;
      const rawFile = `top5_${clipId}_seg_${i}_${tmpId}.mp4`;
      logger.info({ clipId, moment: i + 1, of: ordered.length, rank: seg.rank }, "Rendering Top 5 moment");
      try {
        await processClip(
          seg.localFile ? null : seg.youtubeUrl!, seg.startTime, seg.endTime, seg.headline ?? "",
          rawFile, "edited", "", 0, seg.localFile || undefined, frameStyle, seg.sourceChannel || sourceChannel,
          false, isLast && outroEnabled, false, "",
          seg.punchInEnabled ?? false, seg.zoomMoments ?? "", "", "hook", "", {}, seg.rank
        );
      } catch (err) {
        // Clean the inner yt-dlp/ffmpeg error, then tag which moment failed so a Retry is targeted.
        throw new Error(`Moment #${seg.rank}: ${parseProcessingError(err instanceof Error ? err.message : String(err))}`);
      }
      const rawPath = path.join(outputDir, rawFile);
      if (!fs.existsSync(rawPath)) throw new Error(`Top 5: moment #${seg.rank} produced no file`);

      const badgedPath = path.join(outputDir, `top5_${clipId}_norm_${i}_${tmpId}.mp4`);
      await spawnProcess("ffmpeg", [
        "-y", "-i", rawPath,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(fps),
        "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", badgedPath,
      ], 0, () => {}, RENDER_STALL_MS, "render");
      try { fs.existsSync(rawPath) && fs.unlinkSync(rawPath); } catch { /* ignore */ }
      if (!fs.existsSync(badgedPath)) throw new Error(`Top 5: normalize pass failed for moment #${seg.rank}`);
      parts.push(badgedPath);
      await updateProgress(6 + ((i + 1) / ordered.length) * 55, true);
    }

    // 3) Concat — every part shares identical encode params, so stream-copy is safe.
    const listPath = path.join(outputDir, `top5_${clipId}_list_${tmpId}.txt`);
    fs.writeFileSync(listPath, parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    const stitchedPath = path.join(outputDir, `top5_${clipId}_stitched_${tmpId}.mp4`);
    await spawnProcess("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-c", "copy", "-movflags", "+faststart", stitchedPath,
    ], 0, () => {}, RENDER_STALL_MS, "render");
    if (!fs.existsSync(stitchedPath)) throw new Error("Top 5 concat produced no output");
    fs.renameSync(stitchedPath, finalOutputPath);
    await updateProgress(68, true);

    const totalDuration = (await probeContentDuration(finalOutputPath)) || 0;
    logger.info({ clipId, totalDuration, moments: ordered.length }, "Top 5 stitched");

    // 4) Thumbnail (non-fatal)
    try {
      const thumbPath = path.join(outputDir, `clip_${clipId}_thumb.jpg`);
      await spawnProcess("ffmpeg", ["-y", "-i", finalOutputPath, "-vf", "thumbnail=300", "-frames:v", "1", thumbPath], 60000, () => {});
    } catch (thumbErr) {
      logger.warn({ thumbErr }, "Top 5 thumbnail failed (non-fatal)");
    }

    // 5) Captions once over the whole stitched countdown.
    if (captionsEnabled && totalDuration > 0) {
      await burnCaptionsOnFile(clipId, finalOutputPath, totalDuration, outroEnabled, captionColor, "", "", WATERMARK_HANDLE);
    }
    await updateProgress(85, true);

    // 6) Countdown voiceover — one narration line per moment, placed at that moment's
    //    START on the stitched timeline (after the title card + earlier moments).
    //    Reuses the story narration mixer (Piper TTS + loudnorm).
    const narrLines: string[] = [];
    let offset = titleDur;
    for (let i = 0; i < ordered.length; i++) {
      const seg = ordered[i]!;
      const line = (seg.narrationLine ?? "").trim();
      if (line) narrLines.push(`${Math.round(offset + 0.25)} | ${line}`);
      offset += (await probeContentDuration(parts[i + 1]!)) || 0;
    }
    const narrationScript = narrLines.join("\n");
    if (narrationScript && totalDuration > 0) {
      // Duck the footage to near-silent (0.05) under the countdown voiceover so each
      // "Number five: …" line is crystal-clear; it snaps back to full volume between lines.
      await mixNarrationOnFile(clipId, finalOutputPath, totalDuration, outroEnabled, narrationScript, top5Voice, top5Speed, 0.05);
    }
    await updateProgress(99, true);
    logger.info({ finalOutputPath }, "Top 5 processing complete");
  } finally {
    // Clean up the title card + per-moment parts + list + any leftover top5 temp files.
    try {
      for (const f of parts) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch { /* ignore */ } }
      const leftovers = fs.readdirSync(outputDir).filter((f) => f.includes(tmpId));
      for (const f of leftovers) {
        const p = path.join(outputDir, f);
        try { fs.existsSync(p) && fs.unlinkSync(p); } catch { /* ignore */ }
      }
    } catch (cleanupErr) {
      logger.warn({ cleanupErr, tmpId }, "Failed to clean up Top 5 temp files");
    }
  }
}
