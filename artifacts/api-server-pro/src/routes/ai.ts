import { Router } from "express";
import { getAiClipSuggestion } from "../lib/aiHelper";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import os from "os";

const execFileAsync = promisify(execFile);
const aiRouter = Router();

function findYtDlp(): string {
  const candidates = [
    "/data/data/com.termux/files/usr/bin/yt-dlp",
    "/home/runner/workspace/.pythonlibs/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "yt-dlp";
}

async function fetchTranscriptViaYtDlp(videoUrl: string): Promise<string> {
  const tmpDir = os.tmpdir();
  const tmpId = `yt_transcript_${Date.now()}`;
  const outBase = path.join(tmpDir, tmpId);
  const ytdlp = findYtDlp();

  await execFileAsync(
    ytdlp,
    [
      "--write-auto-subs",
      "--write-subs",
      "--convert-subs", "srt",
      "--sub-lang", "en",
      "--skip-download",
      "--no-warnings",
      "--no-playlist",
      "-o", outBase,
      videoUrl,
    ],
    { timeout: 30_000 }
  );

  const files = fs.readdirSync(tmpDir).filter(
    (f) => f.startsWith(tmpId) && f.endsWith(".srt")
  );
  if (files.length === 0) throw new Error("No captions found for this video");

  const raw = fs.readFileSync(path.join(tmpDir, files[0]), "utf-8");

  for (const f of files) {
    try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* ignore */ }
  }

  // Strip SRT sequence numbers, timestamps, and HTML tags
  return raw
    .split(/\r?\n/)
    .filter((line) => !line.match(/^\d+$/) && !line.match(/\d{2}:\d{2}:\d{2},\d{3}\s*-->/))
    .map((line) => line.replace(/<[^>]+>/g, "").trim())
    .filter(Boolean)
    .join(" ");
}

aiRouter.post("/ai-suggest", async (req, res) => {
  const { youtubeUrl } = req.body as { youtubeUrl?: string };

  if (!youtubeUrl) {
    res.status(400).json({ error: "YouTube URL is required" });
    return;
  }

  const videoIdMatch = youtubeUrl.match(
    /(?:youtu\.be\/|youtube\.com\/(?:shorts\/|live\/|embed\/|v\/|watch\?v=))([^&?/]+)/
  );
  const videoId = videoIdMatch?.[1];
  if (!videoId) {
    res.status(400).json({ error: "Could not extract video ID from URL" });
    return;
  }

  let transcript: string;
  try {
    transcript = await fetchTranscriptViaYtDlp(
      `https://www.youtube.com/watch?v=${videoId}`
    );
  } catch (error) {
    console.error("Transcript fetch error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      error: msg.includes("No captions")
        ? msg
        : "Failed to fetch transcript. The video may not have captions enabled.",
    });
    return;
  }

  try {
    const suggestion = await getAiClipSuggestion(transcript);
    res.json(suggestion);
  } catch (error) {
    console.error("AI generation error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    const lower = msg.toLowerCase();
    let friendly: string;
    if (lower.includes("api_key_invalid") || lower.includes("api key") || lower.includes("invalid api key") || lower.includes("403")) {
      friendly = "Invalid Gemini API key. Set a valid GEMINI_API_KEY in your .env (get one at aistudio.google.com).";
    } else if (lower.includes("quota") || msg.includes("429")) {
      friendly = "Gemini quota exceeded. Try again in a few minutes.";
    } else {
      friendly = `AI error: ${msg}`;
    }
    res.status(500).json({ error: friendly });
  }
});

export default aiRouter;
