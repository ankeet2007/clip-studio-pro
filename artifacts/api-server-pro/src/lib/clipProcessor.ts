import { execFile, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import os from "os";
import { inArray, eq } from "drizzle-orm";
import { db, clipsTable } from "@workspace/db-pro";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);

const OUTPUT_DIR = process.env.CLIPS_OUTPUT_DIR ?? path.join(os.homedir(), "myapp", "clips_output");
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(os.homedir(), "myapp", "uploads");
const FONTS_DIR = path.join(findWorkspaceRoot(), "assets", "fonts");
const WATERMARK_FONT = path.join(FONTS_DIR, "Sora-SemiBold.ttf");
const ANTON_FONT = path.join(FONTS_DIR, "Anton-Regular.ttf");
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

function timeToSeconds(ts: string): number {
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

export function parseProcessingError(raw: string): string {
  // Detect process kill / timeout before parsing stderr content
  if (/killed|timed out|SIGTERM|SIGKILL/i.test(raw) && !raw.includes("ERROR:")) {
    return "Download timed out — the clip may be too long or the connection was slow. Try a shorter segment.";
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
  return async (pct: number, force = false) => {
    if (!clipId) return;
    const now = Date.now();
    if (!force && now - lastTime < 1000) return;
    lastTime = now;
    try {
      await db
        .update(clipsTable)
        .set({ progress: Math.min(100, Math.max(0, Math.round(pct))) })
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
  stallTimeoutMs = 90_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    // detached: true puts yt-dlp in its own process group so that killing the group
    // also kills any grandchild ffmpeg processes spawned by yt-dlp. Without this,
    // killing yt-dlp leaves internal ffmpeg running as an orphan indefinitely.
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stderrBuf = "";
    let done = false;

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
        () => fail(`killed|download stalled — no output for ${stallTimeoutMs / 1000}s\n${stderrBuf}`),
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
            () => fail(`killed|timed out after ${timeoutMs / 1000}s\n${stderrBuf}`),
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
    "--retries", "10",
    "--fragment-retries", "inf",
    youtubeUrl,
  ];
}

/**
 * Downloads the exact time segment from YouTube using yt-dlp --download-sections.
 *
 * Strategy:
 *   1. DASH 1080p via native downloader + concurrent fragments.
 *      --downloader native makes yt-dlp download each DASH segment individually from the
 *      manifest, then ffmpeg muxes from local files. This avoids yt-dlp's internal ffmpeg
 *      seeking sequentially through the full CDN stream (which hangs on archived live recordings
 *      because it has to read through all content before the timestamp first).
 *      --concurrent-fragments 4 downloads up to 4 segments in parallel for faster throughput.
 *   2. 720p DASH via native downloader (same approach, smaller file).
 *   3. Format 18 = 360p H.264+AAC combined progressive mp4 — final reliable fallback.
 *      Not DASH; moov-atom index lets ffmpeg seek without reading the whole file.
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
  const nativeArgs = ["--downloader", "native", "--concurrent-fragments", "4", "--remote-components", "ejs:github"];

  const attempts: Array<{ format: string; label: string; stallMs: number; hardMs: number; extraArgs?: string[] }> = [
    {
      format: "95/93/94/best[protocol=m3u8_native]/best[protocol=m3u8]",
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
      extraArgs: ["--downloader", "native", "--concurrent-fragments", "4", "--remote-components", "ejs:github", "--extractor-args", "youtube:player_client=android_vr,web"],
    },
    {
      format: "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720][ext=mp4]+bestaudio/bestvideo[height<=720]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio",
      label: "DASH 720p (native)",
      stallMs: 300_000,
      hardMs: 600_000,
      extraArgs: ["--downloader", "native", "--concurrent-fragments", "4", "--remote-components", "ejs:github", "--extractor-args", "youtube:player_client=android_vr,web"],
    },
    {
      format: "18/best[ext=mp4]/best",
      label: "progressive mp4 fallback (360p)",
      stallMs: 300_000,
      hardMs: 300_000,
      extraArgs: ["--extractor-args", "youtube:player_client=android_vr,web"],
    },
    {
      format: "best",
      label: "best available (any format)",
      stallMs: 300_000,
      hardMs: 300_000,
      extraArgs: ["--extractor-args", "youtube:player_client=android_vr,web"],
    },
  ]

  let lastError: Error = new Error("no attempts made");

  for (const [i, attempt] of attempts.entries()) {
    const attemptId = i === 0 ? tmpId : `${tmpId}_fb${i}`;
    const outTemplate = path.join(tmpDir, `clip_raw_${attemptId}.%(ext)s`);

    logger.info(
      { youtubeUrl, startTime, endTime, section, format: attempt.format, attempt: i + 1 },
      "Downloading segment via yt-dlp"
    );

    try {
      await spawnProcess(
        ytDlp,
        buildYtDlpArgs(section, attempt.format, outTemplate, youtubeUrl, (attempt.extraArgs ?? []).join(" ").includes("android_vr") ? [] : cookiesArgs, attempt.extraArgs ?? []),
        attempt.hardMs,
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
      const candidates = ["mp4", "mkv", "webm"].map((ext) =>
        path.join(tmpDir, `clip_raw_${attemptId}.${ext}`)
      );
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
      }
      const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(`clip_raw_${attemptId}`));
      if (files.length > 0) return path.join(tmpDir, files[0]!);

      throw new Error("yt-dlp finished but no output file found");
    } catch (err) {
      lastError = err as Error;
      const msg = lastError.message;
      const isStallOrTimeout = /killed\|/.test(msg) || msg.includes("stalled") || msg.includes("timed out") || /live event has ended/i.test(msg) || msg.includes("not available");

      if (!isStallOrTimeout || i === attempts.length - 1) {
        // Real error, or we've exhausted all fallbacks
        throw lastError;
      }

      logger.warn(
        { attempt: attempt.label, error: msg.slice(0, 200) },
        `Download stalled on ${attempt.label}; retrying with ${attempts[i + 1]!.label}`
      );
    }
  }

  throw lastError;
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
  voiceoverHook = ""
): Promise<void> {
  const isLocalFile = !!localFilePath;
  const ytDlp = findYtDlp();
  const outputDir = getOutputDir();
  const finalOutputPath = path.join(outputDir, outputFilename);

  const startSeconds = timeToSeconds(startTime);
  const endSeconds = timeToSeconds(endTime);
  const duration = endSeconds - startSeconds;

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
        // Keep the title block inside the top bar (videoY tall) with breathing room.
        max_height: videoY - 40,
        output_path: tmpPngPath,
      });
      const python3 = findPython();
      const renderOutput = await execFileAsync(python3, [RENDER_HEADLINE_SCRIPT, renderParams], { timeout: 30000 });
      const renderResult = JSON.parse(renderOutput.stdout.trim()) as { height: number; lines: number };
      pngHeight = renderResult.height;
      logger.info({ tmpPngPath, pngHeight, lines: renderResult.lines }, "Headline PNG rendered");
    }

    await updateProgress(45, true);

    // Position: center the headline PNG vertically in the top white bar
    const hlY = Math.max(30, Math.floor((videoY - pngHeight) / 2));

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

    // Step 3: Build ffmpeg filter graph
    // Inputs: [0] = downloaded video clip, [1] = headline PNG (if headline is set)
    const extraInputs: string[] = [];
    const filters: string[] = [
      // Split the source: one copy becomes a blurred, dimmed full-frame backdrop
      // (true "immersive" look), the other is the sharp centred video.
      `[0:v]split=2[vsrc][vbg]`,
      `[vbg]scale=216:384:force_original_aspect_ratio=increase,crop=216:384,gblur=sigma=9,scale=${canvasW}:${canvasH}:flags=bilinear,eq=brightness=-0.30:saturation=1.15[bg]`,
      `[vsrc]scale=${videoW}:${videoH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${videoW}:${videoH},unsharp=5:5:1.0:5:5:0.0[vid]`,
      `[bg][vid]overlay=0:${videoY}[composedv]`,
      // Soft dark scrims behind the title and handle so white text stays legible
      // over the blurred backdrop.
      `[composedv]drawbox=x=0:y=0:w=${canvasW}:h=${videoY}:color=black@0.30:t=fill[scrimtop]`,
      `[scrimtop]drawbox=x=0:y=${videoY + videoH}:w=${canvasW}:h=${canvasH - videoY - videoH}:color=black@0.30:t=fill[composedsc]`,
      `[composedsc]drawbox=x=0:y=${videoY - 3}:w=${canvasW}:h=3:color=FF0000:t=fill[composedac]`,
      sourceChannel && sourceChannel.trim() ? `[composedac]drawtext=text='📎 ${sourceChannel.trim().replace(/'/g,"")}':fontsize=24:fontcolor=white@0.85:x=w-text_w-16:y=${videoY + videoH - 36}:shadowx=1:shadowy=1:shadowcolor=black@0.9[composed]` : `[composedac]null[composed]`,
    ];
    let prevLabel = "composed";

    if (tmpPngPath && pngHeight > 0) {
      // -loop 1 makes the still PNG repeat for the full video duration; -t (below) cuts it
      extraInputs.push("-loop", "1", "-i", tmpPngPath);
      filters.push(`[1:v]format=rgba[hl]`);
      filters.push(`[${prevLabel}][hl]overlay=x=0:y=${hlY}[after_hl]`);
      prevLabel = "after_hl";
    }

    // Channel handle watermark: small white text with shadow near the bottom of the video frame
    if (channelHandle && channelHandle.trim()) {
      // Watermark uses Anton (bold condensed display face, same as the headline) in
      // uppercase so it reads strongly. It lives in the black bar below the video, so
      // it is always horizontally centered — the source-watermark overlap shift in
      // handleX only matters for text drawn over the video frame, not down here.
      const safeHandle = escapeDrawtext(channelHandle.trim().toUpperCase());
      const handleFont = fs.existsSync(ANTON_FONT) ? ANTON_FONT : (fs.existsSync(WATERMARK_FONT) ? WATERMARK_FONT : fontFile);
      const handleFontSize = 48;
      const handleY = videoY + videoH + Math.floor((canvasH - videoY - videoH - handleFontSize) / 2);  // vertically centered in bottom bar
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
      // Outro card: last 2 seconds = black overlay + styled end screen
      const outroStart = Math.max(0, duration - 2);
      const safeHandleOutro = (channelHandle || '').replace(/'/g, '').trim();
      filters.push(
        // Black overlay
        `[pre_outro]drawbox=x=0:y=0:w=${canvasW}:h=${canvasH}:color=black@1:t=fill:enable='gte(t,${outroStart})'[ob]`,
        // Thin red accent line top
        `[ob]drawbox=x=340:y=700:w=400:h=3:color=FF0000:t=fill:enable='gte(t,${outroStart})'[ol1]`,
        // Channel handle
        `[ol1]drawtext=text='${safeHandleOutro}':fontsize=44:fontcolor=white:x=(w-text_w)/2:y=750:enable='gte(t,${outroStart})'[ol2]`,
        // Red subscribe button background
        `[ol2]drawbox=x=${Math.floor((canvasW - 380) / 2)}:y=830:w=380:h=80:color=FF0000:t=fill:enable='gte(t,${outroStart})'[ol3]`,
        // SUBSCRIBE text inside red button
        `[ol3]drawtext=text='SUBSCRIBE':fontsize=42:fontcolor=white:x=(w-text_w)/2:y=848:enable='gte(t,${outroStart})'[ol4]`,
        // Thin red accent line bottom
        `[ol4]drawbox=x=340:y=940:w=400:h=3:color=FF0000:t=fill:enable='gte(t,${outroStart})'[out]`
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
    // phone. ffmpeg prints a progress line per ~second, so the 90s stall timer still
    // kills a genuine hang. (Was 600000 — too short for 1080p renders on slow ARM.)
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
    });

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
        const captionScript = path.join(os.homedir(), "myapp/scripts/generate_captions.sh");
        const captionedPath = path.join(outputDir, `clip_${clipId}_captioned.mp4`);

        if (fs.existsSync(captionScript)) {
          await new Promise<void>((resolve) => {
            // 30 min cap: whisper small.en is slow on the phone (~6 min for a ~45s clip);
            // 5 min was too short and silently dropped captions on longer segments.
            const cap = spawn("bash", [captionScript, finalOutputPath, srtPath, transcriptPath], { timeout: 1_800_000 });
            cap.on("close", () => resolve());
            cap.on("error", () => resolve());
          });

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
            const karaokeScript = path.join(os.homedir(), "myapp/scripts/karaoke_captions.py");
            let subFilter = `subtitles=${srtPath}:fontsdir=${FONTS_DIR}:force_style='FontName=DejaVu Sans,FontSize=12,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=1,Bold=1,Alignment=2,MarginV=95'`;
            if (fs.existsSync(karaokeScript)) {
              try {
                await execFileAsync(findPython(), [karaokeScript, srtPath, assPath, String(Math.max(0, duration - 2))], { timeout: 30000 });
                if (fs.existsSync(assPath) && fs.readFileSync(assPath, "utf8").includes("Dialogue:")) {
                  subFilter = `subtitles=${assPath}:fontsdir=${FONTS_DIR}`;
                }
              } catch (kErr) {
                logger.warn({ kErr }, "Karaoke caption generation failed — falling back to plain SRT");
              }
            }

            await spawnProcess("ffmpeg", [
              "-y", "-i", finalOutputPath,
              "-vf", subFilter,
              "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-threads", "1",
              "-c:a", "copy",
              captionedPath,
              // No hard timeout — caption burn is another full crf-14 re-encode that
              // can also exceed 10 min on the phone; stall timer still guards hangs.
            ], 0, () => {});

            if (fs.existsSync(captionedPath)) {
              fs.renameSync(captionedPath, finalOutputPath);
              logger.info({ finalOutputPath }, "Captions burned into clip");
            }
            fs.existsSync(srtPath) && fs.unlinkSync(srtPath);
            fs.existsSync(assPath) && fs.unlinkSync(assPath);
          }
        }
      } catch (capErr) {
        logger.warn({ capErr }, "Caption generation failed (non-fatal)");
      }

      // Pro: AI intro-hook voiceover. Speak the user-supplied hook line (Piper TTS,
      // local) over the first few seconds with the original audio ducked underneath.
      // Runs as a cheap audio-only pass — the video stream is copied, only the audio
      // is re-encoded — so it adds negligible time even on the phone. Non-fatal.
      if (voiceoverEnabled && voiceoverHook && voiceoverHook.trim()) try {
        const hookWav = path.join(outputDir, `clip_${clipId}_hook.wav`);
        const voiceScript = path.join(os.homedir(), "myapp/scripts/generate_voiceover.sh");

        if (fs.existsSync(voiceScript)) {
          await new Promise<void>((resolve) => {
            const v = spawn("bash", [voiceScript, voiceoverHook.trim(), hookWav], { timeout: 120_000 });
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
