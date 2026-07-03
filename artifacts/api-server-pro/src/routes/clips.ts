import { Router, type IRouter } from "express";
import fs from "fs";
import path from "path";
import busboy from "busboy";
import { eq, desc, count } from "drizzle-orm";
import { db, clipsTable } from "@workspace/db-pro";
import {
  CreateClipBody,
  GetClipParams,
  DeleteClipParams,
  ListClipsResponse,
  GetClipResponse,
  GetClipStatsResponse,
} from "@workspace/api-zod";
import { processClip, processStory, enqueueClipJob, getOutputFilePath, getUploadsDir, normalizeYoutubeUrl, parseProcessingError, validateSegmentWithinVideo, type StorySegment } from "../lib/clipProcessor";
import { logger } from "../lib/logger";
import { readSettings } from "../lib/settings";

const router: IRouter = Router();

router.get("/clips/stats", async (req, res): Promise<void> => {
  const rows = await db
    .select({ status: clipsTable.status, cnt: count() })
    .from(clipsTable)
    .groupBy(clipsTable.status);

  const stats = { total: 0, pending: 0, processing: 0, done: 0, error: 0 };
  for (const row of rows) {
    const n = Number(row.cnt);
    stats.total += n;
    if (row.status === "pending") stats.pending = n;
    else if (row.status === "processing") stats.processing = n;
    else if (row.status === "done") stats.done = n;
    else if (row.status === "error") stats.error = n;
  }

  res.json(GetClipStatsResponse.parse(stats));
});

router.get("/clips", async (req, res): Promise<void> => {
  const clips = await db
    .select()
    .from(clipsTable)
    .orderBy(desc(clipsTable.createdAt));

  res.json(ListClipsResponse.parse(clips));
});

function dispatchClipJob(
  clipId: number,
  youtubeUrl: string | null,
  startTime: string,
  endTime: string,
  headline: string,
  outputFilename: string,
  mode: "edited" | "raw" = "edited",
  frameStyle: "standard" | "immersive" = "immersive",
  localFilePath?: string,
  sourceChannel = "",
  captionsEnabled = true,
  outroEnabled = true,
  voiceoverEnabled = false,
  voiceoverHook = "",
  punchInEnabled = false,
  zoomMoments = "",
  captionColor = "",
  voiceoverMode: "hook" | "script" = "hook",
  narrationScript = ""
) {
  const { channelHandle } = readSettings();

  enqueueClipJob(async () => {
    // Mark as processing BEFORE starting work so the status can never be
    // overwritten back to "processing" after "done" (the old fire-and-forget race).
    try {
      await db.update(clipsTable)
        .set({ status: "processing" })
        .where(eq(clipsTable.id, clipId))
        .execute();
    } catch (err: unknown) {
      logger.error({ err, clipId }, "Failed to mark clip as processing");
    }

    await processClip(youtubeUrl, startTime, endTime, headline, outputFilename, mode, channelHandle, clipId, localFilePath, frameStyle, sourceChannel, captionsEnabled, outroEnabled, voiceoverEnabled, voiceoverHook, punchInEnabled, zoomMoments, captionColor, voiceoverMode, narrationScript)
      .then(async () => {
        await db
          .update(clipsTable)
          .set({ status: "done", progress: 100, outputFilename })
          .where(eq(clipsTable.id, clipId));
      })
      .catch(async (err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = parseProcessingError(raw);
        await db
          .update(clipsTable)
          .set({ status: "error", progress: 0, errorMessage: msg })
          .where(eq(clipsTable.id, clipId));
      });
  });
}

/**
 * Enqueues a STORY job (Feature 2): render N segments from one source, stitch them,
 * then caption + narrate the whole. Mirrors dispatchClipJob's status handling.
 */
function dispatchStoryJob(
  clipId: number,
  youtubeUrl: string,
  outputFilename: string,
  frameStyle: "standard" | "immersive",
  sourceChannel: string,
  captionsEnabled: boolean,
  outroEnabled: boolean,
  captionColor: string,
  narrationScript: string,
  segments: StorySegment[]
) {
  const { channelHandle } = readSettings();
  enqueueClipJob(async () => {
    try {
      await db.update(clipsTable).set({ status: "processing" }).where(eq(clipsTable.id, clipId)).execute();
    } catch (err: unknown) {
      logger.error({ err, clipId }, "Failed to mark story as processing");
    }
    await processStory(youtubeUrl, outputFilename, channelHandle, clipId, frameStyle, sourceChannel, captionsEnabled, outroEnabled, captionColor, narrationScript, segments)
      .then(async () => {
        await db.update(clipsTable).set({ status: "done", progress: 100, outputFilename }).where(eq(clipsTable.id, clipId));
      })
      .catch(async (err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = parseProcessingError(raw);
        await db.update(clipsTable).set({ status: "error", progress: 0, errorMessage: msg }).where(eq(clipsTable.id, clipId));
      });
  });
}

/** Normalises + validates a raw segments array from the request body. */
function sanitizeSegments(raw: unknown): StorySegment[] {
  if (!Array.isArray(raw)) return [];
  const timeRe = /^\d{1,2}:\d{2}(:\d{2})?$/;
  const toHMS = (t: string) => { const p = t.split(":"); while (p.length < 3) p.unshift("00"); return p.slice(-3).map((x) => x.padStart(2, "0")).join(":"); };
  const out: StorySegment[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const seg = s as Record<string, unknown>;
    const st = String(seg.startTime ?? "").trim();
    const en = String(seg.endTime ?? "").trim();
    if (!timeRe.test(st) || !timeRe.test(en)) continue;
    out.push({
      startTime: toHMS(st),
      endTime: toHMS(en),
      headline: String(seg.headline ?? "").slice(0, 120),
      zoomMoments: typeof seg.zoomMoments === "string" ? seg.zoomMoments : "",
      punchInEnabled: seg.punchInEnabled === true,
    });
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * POST /clips/story — create a multi-clip story job (Feature 2). Reads fields off the
 * body directly (same convention as the other newer fields — the shared CreateClipBody
 * zod schema is not used here).
 */
router.post("/clips/story", async (req, res): Promise<void> => {
  const body = req.body as {
    youtubeUrl?: string; frameStyle?: string; sourceChannel?: string;
    captionsEnabled?: boolean; outroEnabled?: boolean; captionColor?: string;
    narrationScript?: string; segments?: unknown;
  };
  const rawUrl = (body.youtubeUrl ?? "").trim();
  if (!rawUrl) { res.status(400).json({ error: "A source YouTube URL is required" }); return; }
  const youtubeUrl = normalizeYoutubeUrl(rawUrl);

  const segments = sanitizeSegments(body.segments);
  if (segments.length < 2) {
    res.status(400).json({ error: "A story needs at least 2 valid segments (each with a start and end time)." });
    return;
  }

  const frameStyle = (body.frameStyle === "standard" ? "standard" : "immersive") as "standard" | "immersive";
  const sourceChannel = body.sourceChannel ?? "";
  const captionsEnabled = body.captionsEnabled ?? true;
  const outroEnabled = body.outroEnabled ?? true;
  const captionColor = body.captionColor ?? "";
  const narrationScript = body.narrationScript ?? "";

  // Representative fields so a story row displays sensibly in the timeline/detail.
  const headline = segments[0]!.headline?.trim() || `Story · ${segments.length} moments`;
  const startTime = segments[0]!.startTime;
  const endTime = segments[segments.length - 1]!.endTime;

  const [clip] = await db
    .insert(clipsTable)
    .values({
      youtubeUrl, startTime, endTime, headline, mode: "edited", frameStyle, sourceChannel,
      captionsEnabled, captionColor, outroEnabled, narrationScript,
      jobType: "story", segments, sourceType: "youtube", status: "pending",
    })
    .returning();

  if (!clip) { res.status(500).json({ error: "Failed to create story" }); return; }

  res.status(201).json(GetClipResponse.parse(clip));

  const outputFilename = `clip_${clip.id}_${Date.now()}.mp4`;
  dispatchStoryJob(clip.id, youtubeUrl, outputFilename, frameStyle, sourceChannel, captionsEnabled, outroEnabled, captionColor, narrationScript, segments);
});

router.post("/clips", async (req, res): Promise<void> => {
  const parsed = CreateClipBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { startTime, endTime } = parsed.data;
  const youtubeUrl = normalizeYoutubeUrl(parsed.data.youtubeUrl);
  const headline = parsed.data.headline ?? "";
  const mode = (parsed.data.mode ?? "edited") as "edited" | "raw";
  const frameStyle = (parsed.data.frameStyle ?? "immersive") as "standard" | "immersive";
  const sourceChannel = parsed.data.sourceChannel ?? "";
  const captionsEnabled = parsed.data.captionsEnabled ?? true;
  const outroEnabled = (req.body as { outroEnabled?: boolean }).outroEnabled ?? true;
  const voiceoverEnabled = (req.body as { voiceoverEnabled?: boolean }).voiceoverEnabled ?? false;
  const voiceoverHook = (req.body as { voiceoverHook?: string }).voiceoverHook ?? "";
  const punchInEnabled = (req.body as { punchInEnabled?: boolean }).punchInEnabled ?? false;
  const zoomMoments = (req.body as { zoomMoments?: string }).zoomMoments ?? "";
  const captionColor = (req.body as { captionColor?: string }).captionColor ?? "";
  const voiceoverMode = ((req.body as { voiceoverMode?: string }).voiceoverMode === "script" ? "script" : "hook") as "hook" | "script";
  const narrationScript = (req.body as { narrationScript?: string }).narrationScript ?? "";

  // Up-front guard: reject a start time that falls past the end of the source video so the user
  // gets an immediate, clear "that timestamp doesn't exist" error instead of a frozen/failed
  // render minutes later. Best-effort (never blocks on a transient metadata-fetch failure).
  const rangeCheck = await validateSegmentWithinVideo(youtubeUrl, startTime, endTime);
  if (!rangeCheck.ok) {
    res.status(400).json({ error: rangeCheck.message });
    return;
  }

  const [clip] = await db
    .insert(clipsTable)
    .values({ youtubeUrl, startTime, endTime, headline, mode, frameStyle, sourceChannel, captionsEnabled, captionColor, voiceoverEnabled, voiceoverHook, voiceoverMode, narrationScript, punchInEnabled, zoomMoments, outroEnabled, sourceType: "youtube", status: "pending" })
    .returning();

  if (!clip) {
    res.status(500).json({ error: "Failed to create clip" });
    return;
  }

  res.status(201).json(GetClipResponse.parse(clip));

  const outputFilename = `clip_${clip.id}_${Date.now()}.mp4`;
  dispatchClipJob(clip.id, youtubeUrl, startTime, endTime, headline, outputFilename, mode, frameStyle, undefined, sourceChannel, captionsEnabled, outroEnabled, voiceoverEnabled, voiceoverHook, punchInEnabled, zoomMoments, captionColor, voiceoverMode, narrationScript);
});

/**
 * POST /clips/upload — stream a local video file (up to 20 GB) to disk then process it.
 * Accepts multipart/form-data with fields: file (required), startTime, endTime, headline, mode.
 */
router.post("/clips/upload", (req, res): void => {
  const uploadsDir = getUploadsDir();
  const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

  let startTime = "00:00:00";
  let endTime = "00:01:00";
  let headline = "";
  let mode: "edited" | "raw" = "edited";
  let frameStyle: "standard" | "immersive" = "immersive";
  let sourceChannel = "";
  let captionsEnabled = true;
  let captionColor = "";
  let voiceoverEnabled = false;
  let voiceoverHook = "";
  let voiceoverMode: "hook" | "script" = "hook";
  let narrationScript = "";
  let punchInEnabled = false;
  let zoomMoments = "";
  let outroEnabled = true;
  let savedFilePath: string | null = null;
  let savedFileName: string | null = null;
  let fileWritePromise: Promise<void> | null = null;

  let bb: ReturnType<typeof busboy>;
  try {
    bb = busboy({
      headers: req.headers,
      limits: { fileSize: 20 * 1024 * 1024 * 1024 },
    });
  } catch {
    res.status(400).json({ error: "Invalid multipart request" });
    return;
  }

  bb.on("field", (name: string, value: string) => {
    if (name === "startTime") startTime = value.trim() || "00:00:00";
    if (name === "endTime") endTime = value.trim() || "00:01:00";
    if (name === "headline") headline = value;
    if (name === "mode" && (value === "edited" || value === "raw")) mode = value;
    if (name === "frameStyle" && (value === "standard" || value === "immersive")) frameStyle = value;
    if (name === "sourceChannel") sourceChannel = value;
    if (name === "captionsEnabled") captionsEnabled = value !== "false";
    if (name === "captionColor") captionColor = value;
    if (name === "voiceoverEnabled") voiceoverEnabled = value === "true";
    if (name === "voiceoverHook") voiceoverHook = value;
    if (name === "voiceoverMode" && (value === "hook" || value === "script")) voiceoverMode = value;
    if (name === "narrationScript") narrationScript = value;
    if (name === "punchInEnabled") punchInEnabled = value === "true";
    if (name === "zoomMoments") zoomMoments = value;
    if (name === "outroEnabled") outroEnabled = value !== "false";
  });

  bb.on("file", (_name: string, stream: NodeJS.ReadableStream, info: { filename: string; encoding: string; mimeType: string }) => {
    const ext = path.extname(info.filename).toLowerCase() || ".mp4";
    const filename = `upload_${tmpId}${ext}`;
    savedFileName = info.filename || filename;
    savedFilePath = path.join(uploadsDir, filename);

    const writeStream = fs.createWriteStream(savedFilePath);
    (stream as NodeJS.ReadableStream).pipe(writeStream);

    fileWritePromise = new Promise<void>((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", (err) => {
        reject(err);
      });
      stream.on("error", (err: Error) => {
        writeStream.destroy();
        reject(err);
      });
    });
  });

  bb.on("finish", () => {
    void (async () => {
      try {
        if (!savedFilePath || !fileWritePromise) {
          res.status(400).json({ error: "No video file received" });
          return;
        }

        await fileWritePromise;

        const stat = fs.statSync(savedFilePath);
        if (stat.size === 0) {
          fs.unlinkSync(savedFilePath);
          res.status(400).json({ error: "Uploaded file is empty" });
          return;
        }

        const [clip] = await db
          .insert(clipsTable)
          .values({
            youtubeUrl: null,
            startTime,
            endTime,
            headline,
            mode,
            frameStyle,
            sourceType: "local",
            sourceChannel,
            captionsEnabled,
            captionColor,
            voiceoverEnabled,
            voiceoverHook,
            voiceoverMode,
            narrationScript,
            punchInEnabled,
            zoomMoments,
            outroEnabled,
            localFilePath: savedFilePath,
            localFileName: savedFileName,
            status: "pending",
          })
          .returning();

        if (!clip) {
          fs.unlinkSync(savedFilePath);
          res.status(500).json({ error: "Failed to create clip record" });
          return;
        }

        res.status(201).json(GetClipResponse.parse(clip));

        const outputFilename = `clip_${clip.id}_${Date.now()}.mp4`;
        dispatchClipJob(clip.id, null, startTime, endTime, headline, outputFilename, mode, frameStyle, savedFilePath, sourceChannel, captionsEnabled, outroEnabled, voiceoverEnabled, voiceoverHook, punchInEnabled, zoomMoments, captionColor, voiceoverMode, narrationScript);
      } catch (err) {
        if (savedFilePath) {
          try { if (fs.existsSync(savedFilePath)) fs.unlinkSync(savedFilePath); } catch { /* ignore */ }
        }
        if (!res.headersSent) {
          res.status(500).json({ error: err instanceof Error ? err.message : "Upload failed" });
        }
      }
    })();
  });

  bb.on("error", (err: Error) => {
    logger.error({ err }, "Busboy upload error");
    if (!res.headersSent) {
      res.status(500).json({ error: String(err) });
    }
  });

  req.pipe(bb);
});

router.post("/clips/:id/retry", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetClipParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [clip] = await db
    .select()
    .from(clipsTable)
    .where(eq(clipsTable.id, params.data.id));

  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  if (clip.status !== "error") {
    res.status(400).json({ error: "Only clips in error state can be retried" });
    return;
  }

  // For local file clips, ensure the source file still exists
  if (clip.sourceType === "local" && clip.localFilePath && !fs.existsSync(clip.localFilePath)) {
    res.status(400).json({ error: "Original uploaded file no longer exists — please re-upload" });
    return;
  }

  const outputFilename = `clip_${clip.id}_${Date.now()}.mp4`;

  const [updated] = await db
    .update(clipsTable)
    .set({ status: "pending", progress: 0, errorMessage: null, outputFilename: null })
    .where(eq(clipsTable.id, clip.id))
    .returning();

  if (!updated) {
    res.status(500).json({ error: "Failed to reset clip" });
    return;
  }

  res.json(GetClipResponse.parse(updated));

  const clipFrameStyle = (clip.frameStyle === "standard" ? "standard" : "immersive") as "standard" | "immersive";

  // Story retry: re-render the whole story from the persisted segments + narration.
  if (clip.jobType === "story") {
    dispatchStoryJob(
      clip.id,
      clip.youtubeUrl ? normalizeYoutubeUrl(clip.youtubeUrl) : "",
      outputFilename,
      clipFrameStyle,
      clip.sourceChannel ?? "",
      clip.captionsEnabled ?? true,
      clip.outroEnabled ?? true,
      clip.captionColor ?? "",
      clip.narrationScript ?? "",
      (clip.segments ?? []) as StorySegment[],
    );
    return;
  }

  const clipMode = (clip.mode === "raw" ? "raw" : "edited") as "edited" | "raw";
  const youtubeUrl = clip.youtubeUrl ? normalizeYoutubeUrl(clip.youtubeUrl) : null;
  dispatchClipJob(
    clip.id,
    youtubeUrl,
    clip.startTime,
    clip.endTime,
    clip.headline,
    outputFilename,
    clipMode,
    clipFrameStyle,
    clip.localFilePath ?? undefined,
    clip.sourceChannel ?? "",
    clip.captionsEnabled ?? true,
    clip.outroEnabled ?? true,
    clip.voiceoverEnabled ?? false,
    clip.voiceoverHook ?? "",
    // Persisted settings — a retry re-renders with EXACTLY the same options the clip had
    // before it failed (outro + voiceover + the AI Auto-Zoom Gemini chose). These used to
    // be dropped because they weren't stored / were hardcoded on the retry path.
    clip.punchInEnabled ?? false,
    clip.zoomMoments ?? "",
    clip.captionColor ?? "",
    (clip.voiceoverMode === "script" ? "script" : "hook"),
    clip.narrationScript ?? ""
  );
});

router.get("/clips/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetClipParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [clip] = await db
    .select()
    .from(clipsTable)
    .where(eq(clipsTable.id, params.data.id));

  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  res.json(GetClipResponse.parse(clip));
});

router.get("/clips/:id/download", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetClipParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [clip] = await db
    .select()
    .from(clipsTable)
    .where(eq(clipsTable.id, params.data.id));

  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  if (clip.status !== "done" || !clip.outputFilename) {
    res.status(400).json({ error: "Clip is not ready for download" });
    return;
  }

  const filePath = getOutputFilePath(clip.outputFilename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Output file not found" });
    return;
  }

  res.download(filePath, clip.outputFilename);
});


router.get("/clips/:id/thumbnail", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetClipParams.safeParse({ id: raw });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const [clip] = await db.select().from(clipsTable).where(eq(clipsTable.id, params.data.id));
  if (!clip) { res.status(404).json({ error: "Clip not found" }); return; }
  const outputDir = process.env.CLIPS_OUTPUT_DIR ?? "/home/runner/workspace/clips_output";
  const thumbPath = path.join(outputDir, "clip_" + clip.id + "_thumb.jpg");
  if (!fs.existsSync(thumbPath)) { res.status(404).json({ error: "Thumbnail not ready" }); return; }
  res.sendFile(thumbPath);
});

/**
 * Builds YouTube SEO metadata (title / description / hashtags / tags) for a clip from
 * data already on the row — headline, the whisper transcript, and the source creator.
 * Purely algorithmic: the server makes NO AI calls (same principle as the voiceover hook).
 */
function buildSeoMetadata(clip: typeof clipsTable.$inferSelect): {
  title: string; description: string; hashtags: string; tags: string;
} {
  const headline = (clip.headline || "").trim();
  const channel = (clip.sourceChannel || "").trim();
  const transcript = (clip.transcript || "").trim();

  const STOP = new Set([
    "the","and","for","that","this","with","you","your","are","was","were","have","has",
    "had","what","when","where","which","their","they","them","from","into","just","like",
    "about","over","then","than","but","not","its","get","got","out","one","all","can",
    "will","would","could","should","yeah","gonna","wanna","really","very","there","here",
    "whats","hes","shes","thats","theyre","dont","cant","wont","know","going","right",
    "because","people","something","everything","okay","yes","said","says","were","still",
  ]);
  // Keep apostrophes while matching, then strip them so contractions like "what's"
  // collapse to "whats" (caught by STOP) and never leak into a hashtag (apostrophes
  // are invalid in YouTube hashtags).
  const words = `${headline} ${transcript}`.toLowerCase().match(/[a-z0-9']+/g) || [];
  const freq = new Map<string, number>();
  for (const raw of words) {
    const w = raw.replace(/'/g, "");
    if (w.length < 4 || STOP.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);
  const channelTag = channel ? channel.replace(/[^a-z0-9]/gi, "").toLowerCase() : "";

  const tagList = [...new Set(["shorts", "viral", "fyp", "trending", channelTag, ...top].filter(Boolean))];
  const hashtags = tagList.map((t) => `#${t}`).join(" ");

  // Title: headline-led, under YouTube's 100-char limit, with #Shorts appended.
  let title = headline || (channel ? `${channel} — you won't believe this` : "Watch till the end 🔥");
  const suffix = " #Shorts";
  if (title.length + suffix.length <= 100) title += suffix;
  if (title.length > 100) title = title.slice(0, 100).trimEnd();

  const description = [
    headline || "Watch till the end! 🔥",
    "",
    ...(channel ? [`🎬 Clip from ${channel}`] : []),
    "👉 Subscribe for daily clips!",
    "",
    hashtags,
  ].join("\n");

  return { title, description, hashtags, tags: tagList.join(", ") };
}

router.get("/clips/:id/metadata", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetClipParams.safeParse({ id: raw });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const [clip] = await db.select().from(clipsTable).where(eq(clipsTable.id, params.data.id));
  if (!clip) { res.status(404).json({ error: "Clip not found" }); return; }
  res.json(buildSeoMetadata(clip));
});

router.delete("/clips/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteClipParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [clip] = await db
    .delete(clipsTable)
    .where(eq(clipsTable.id, params.data.id))
    .returning();

  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  // Delete processed output file
  if (clip.outputFilename) {
    const filePath = getOutputFilePath(clip.outputFilename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  // Delete uploaded source file for local clips
  if (clip.localFilePath && fs.existsSync(clip.localFilePath)) {
    try { fs.unlinkSync(clip.localFilePath); } catch { /* ignore */ }
  }

  res.sendStatus(204);
});

export default router;
