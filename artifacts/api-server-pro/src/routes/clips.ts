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
import { processClip, processStory, processTop5, processMatchStory, enqueueClipJob, getOutputFilePath, getUploadsDir, normalizeYoutubeUrl, parseProcessingError, validateSegmentWithinVideo, fetchTranscriptCues, locateMomentInTranscript, timeToSeconds, type StorySegment, type Top5Segment } from "../lib/clipProcessor";
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
  narrationScript = "",
  voiceoverVoice = "",
  voiceoverSpeed = ""
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

    await processClip(youtubeUrl, startTime, endTime, headline, outputFilename, mode, channelHandle, clipId, localFilePath, frameStyle, sourceChannel, captionsEnabled, outroEnabled, voiceoverEnabled, voiceoverHook, punchInEnabled, zoomMoments, captionColor, voiceoverMode, narrationScript, { voice: voiceoverVoice, speed: voiceoverSpeed })
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
  segments: StorySegment[],
  voiceoverVoice = "",
  voiceoverSpeed = ""
) {
  const { channelHandle } = readSettings();
  enqueueClipJob(async () => {
    try {
      await db.update(clipsTable).set({ status: "processing" }).where(eq(clipsTable.id, clipId)).execute();
    } catch (err: unknown) {
      logger.error({ err, clipId }, "Failed to mark story as processing");
    }
    await processStory(youtubeUrl, outputFilename, channelHandle, clipId, frameStyle, sourceChannel, captionsEnabled, outroEnabled, captionColor, narrationScript, segments, { voice: voiceoverVoice, speed: voiceoverSpeed })
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
 * Normalises + validates a raw MATCH STORY beats array. Unlike a single-source story,
 * every beat carries its OWN source URL (multi-source montage) — rows without a URL or a
 * valid start/end are dropped. Capped at 8 (render-load guard on the phone).
 */
// Story Mode 2.0 cut-engine fields (all optional). Asset PATHS are confined to the uploads dir (the
// same guard as localFile) and must exist, so a bad/remote asset is dropped here rather than failing
// mid-render. Scalar fields (density, punchline word, holdMs) are clamped to sane bounds.
function sanitizeCutFields(seg: Record<string, unknown>, uploadsDir: string): Partial<StorySegment> {
  const out: Partial<StorySegment> = {};
  const cd = seg.cutDensity as { minSec?: unknown; maxSec?: unknown } | undefined;
  if (cd && typeof cd === "object") {
    const mn = Number(cd.minSec), mx = Number(cd.maxSec);
    if (Number.isFinite(mn) && Number.isFinite(mx) && mn > 0 && mx >= mn) {
      out.cutDensity = { minSec: Math.min(6, mn), maxSec: Math.min(6, mx) };
    }
  }
  const confine = (p: unknown): string => {
    const s = String(p ?? "").trim();
    if (!s) return "";
    const r = path.resolve(s);
    return r.startsWith(uploadsDir + path.sep) && fs.existsSync(r) ? r : "";
  };
  if (Array.isArray(seg.fillerAssets)) {
    const fa = (seg.fillerAssets as unknown[]).map(confine).filter(Boolean);
    if (fa.length) out.fillerAssets = fa;
  }
  const p = seg.punchline as { word?: unknown; asset?: unknown } | undefined;
  if (p && typeof p === "object") {
    const word = String(p.word ?? "").trim().slice(0, 60);
    const asset = confine(p.asset);
    if (word && asset) out.punchline = { word, asset };
  }
  const h = Number(seg.holdMs);
  if (Number.isFinite(h) && h > 0) out.holdMs = Math.min(10000, h);
  // Verifier description for the coverage gate — carried through so a keyless render box still
  // enforces coverage (see lib/verify/gate.ts). Plain text, no path, so no confinement needed.
  const dep = String(seg.depicts ?? "").trim();
  if (dep) out.depicts = dep.slice(0, 300);
  return out;
}

function sanitizeMatchSegments(raw: unknown): StorySegment[] {
  if (!Array.isArray(raw)) return [];
  const timeRe = /^\d{1,2}:\d{2}(:\d{2})?$/;
  const toHMS = (t: string) => { const p = t.split(":"); while (p.length < 3) p.unshift("00"); return p.slice(-3).map((x) => x.padStart(2, "0")).join(":"); };
  const uploadsDir = path.resolve(getUploadsDir());
  const out: StorySegment[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const seg = s as Record<string, unknown>;
    const st = String(seg.startTime ?? "").trim();
    const en = String(seg.endTime ?? "").trim();
    if (!timeRe.test(st) || !timeRe.test(en)) continue;
    // Match Story 2.0: a scout-downloaded LOCAL clip beat. Confine the path to the uploads
    // dir (no traversal / reading arbitrary files) and require it to exist.
    const rawLocal = String(seg.localFile ?? "").trim();
    const isLocal = seg.sourceType === "local" && rawLocal.length > 0;
    if (isLocal) {
      const resolved = path.resolve(rawLocal);
      if (!resolved.startsWith(uploadsDir + path.sep) || !fs.existsSync(resolved)) continue;
      out.push({
        localFile: resolved,
        sourceType: "local",
        startTime: toHMS(st),
        endTime: toHMS(en),
        headline: String(seg.headline ?? "").slice(0, 120),
        sourceChannel: String(seg.sourceChannel ?? "").slice(0, 80),
        narrationLine: String(seg.narrationLine ?? "").slice(0, 600),
        captionLine: String(seg.captionLine ?? "").slice(0, 600),
        ...sanitizeCutFields(seg, uploadsDir),
      });
      if (out.length >= 8) break;
      continue;
    }
    const rawUrl = String(seg.youtubeUrl ?? "").trim();
    if (!rawUrl) continue;
    out.push({
      youtubeUrl: normalizeYoutubeUrl(rawUrl),
      startTime: toHMS(st),
      endTime: toHMS(en),
      headline: String(seg.headline ?? "").slice(0, 120),
      sourceChannel: String(seg.sourceChannel ?? "").slice(0, 80),
      narrationLine: String(seg.narrationLine ?? "").slice(0, 600),
      zoomMoments: typeof seg.zoomMoments === "string" ? seg.zoomMoments : "",
      punchInEnabled: seg.punchInEnabled === true,
      ...sanitizeCutFields(seg, uploadsDir),
    });
    if (out.length >= 8) break;
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
    voiceoverVoice?: string; voiceoverSpeed?: string;
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
  const voiceoverVoice = body.voiceoverVoice ?? "";
  const voiceoverSpeed = body.voiceoverSpeed ?? "";

  // Representative fields so a story row displays sensibly in the timeline/detail.
  const headline = segments[0]!.headline?.trim() || `Story · ${segments.length} moments`;
  const startTime = segments[0]!.startTime;
  const endTime = segments[segments.length - 1]!.endTime;

  const [clip] = await db
    .insert(clipsTable)
    .values({
      youtubeUrl, startTime, endTime, headline, mode: "edited", frameStyle, sourceChannel,
      captionsEnabled, captionColor, outroEnabled, narrationScript, voiceoverVoice, voiceoverSpeed,
      jobType: "story", segments, sourceType: "youtube", status: "pending",
    })
    .returning();

  if (!clip) { res.status(500).json({ error: "Failed to create story" }); return; }

  res.status(201).json(GetClipResponse.parse(clip));

  const outputFilename = `clip_${clip.id}_${Date.now()}.mp4`;
  dispatchStoryJob(clip.id, youtubeUrl, outputFilename, frameStyle, sourceChannel, captionsEnabled, outroEnabled, captionColor, narrationScript, segments, voiceoverVoice, voiceoverSpeed);
});

/**
 * Enqueues a MATCH STORY job: render each beat from its OWN source URL, stitch them (no
 * title card / no badges), caption once, then a dense play-by-play narration. Mirrors
 * dispatchStoryJob's status handling; "Beat #…" errors are already clean and name the
 * failing beat, so they're passed through verbatim (like Top 5's "Moment #…").
 */
function dispatchMatchStoryJob(
  clipId: number,
  outputFilename: string,
  frameStyle: "standard" | "immersive",
  sourceChannel: string,
  captionsEnabled: boolean,
  outroEnabled: boolean,
  captionColor: string,
  narrationScript: string,
  segments: StorySegment[],
  voiceoverVoice = "",
  voiceoverSpeed = "",
  title = "",
  transitionsEnabled = true,
  titleCardEnabled = false
) {
  const { channelHandle } = readSettings();
  enqueueClipJob(async () => {
    try {
      await db.update(clipsTable).set({ status: "processing" }).where(eq(clipsTable.id, clipId)).execute();
    } catch (err: unknown) {
      logger.error({ err, clipId }, "Failed to mark Match Story as processing");
    }
    await processMatchStory(outputFilename, channelHandle, clipId, frameStyle, sourceChannel, captionsEnabled, outroEnabled, captionColor, narrationScript, segments, { voice: voiceoverVoice, speed: voiceoverSpeed }, title, transitionsEnabled, titleCardEnabled)
      .then(async () => {
        await db.update(clipsTable).set({ status: "done", progress: 100, outputFilename }).where(eq(clipsTable.id, clipId));
      })
      .catch(async (err: unknown) => {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const msg = rawMsg.startsWith("Beat #") ? rawMsg.slice(0, 400) : parseProcessingError(rawMsg);
        await db.update(clipsTable).set({ status: "error", progress: 0, errorMessage: msg }).where(eq(clipsTable.id, clipId));
      });
  });
}

/**
 * POST /clips/matchstory — create a research-driven, MULTI-SOURCE narrated montage. Each
 * beat carries its own source URL; `narrationScript` is the dense play-by-play on the
 * stitched timeline. Reads fields off the body directly (no shared zod schema, same as story).
 */
router.post("/clips/matchstory", async (req, res): Promise<void> => {
  const body = req.body as {
    title?: string; frameStyle?: string; sourceChannel?: string;
    captionsEnabled?: boolean; outroEnabled?: boolean; captionColor?: string;
    narrationScript?: string; segments?: unknown;
    voiceoverVoice?: string; voiceoverSpeed?: string;
    transitionsEnabled?: boolean; titleCardEnabled?: boolean;
  };

  const segments = sanitizeMatchSegments(body.segments);
  if (segments.length < 2) {
    res.status(400).json({ error: "A Match Story needs at least 2 valid beats (each with a source URL and a start/end time)." });
    return;
  }

  // Story-length floor (scout / "Story Mode 2.0" only): the final video length = the spoken
  // narration (each B-roll clip is cut down to its line), so a thin script renders a too-short
  // clip. Count the words across the per-beat lines (+ flat script fallback) and refuse anything
  // that would come out well under a minute. Scoped to all-local (scout) stories so the YouTube
  // Match Story mode is untouched. ~140 words ≈ ~56s speech + per-beat pads/title card ≥ 60s.
  const allLocal = segments.every((s) => s.sourceType === "local");
  if (allLocal) {
    const narrationWords = (segments.map((s) => s.narrationLine ?? "").join(" ") + " " + (body.narrationScript ?? ""))
      .trim().split(/\s+/).filter(Boolean).length;
    const MIN_STORY_WORDS = 140;
    if (narrationWords < MIN_STORY_WORDS) {
      res.status(400).json({
        error: `Story narration is only ~${narrationWords} words (≈${Math.round(narrationWords / 2.4)}s). A Story needs ~150-220 words (60-90s) — go back to Step 1 and get a fuller script before finding clips.`,
      });
      return;
    }
  }

  const transitionsEnabled = body.transitionsEnabled ?? true;
  // Story Mode 2.0 / Scout default to NO intro title card (still overridable per render).
  const titleCardEnabled = body.titleCardEnabled ?? false;

  const frameStyle = (body.frameStyle === "standard" ? "standard" : "immersive") as "standard" | "immersive";
  const sourceChannel = body.sourceChannel ?? "";
  const captionsEnabled = body.captionsEnabled ?? true;
  // Story Mode 2.0 / Scout default to NO outro SUBSCRIBE card (still overridable per render).
  const outroEnabled = body.outroEnabled ?? false;
  const captionColor = body.captionColor ?? "";
  const narrationScript = body.narrationScript ?? "";
  const voiceoverVoice = body.voiceoverVoice ?? "";
  const voiceoverSpeed = body.voiceoverSpeed ?? "";

  // Representative fields so a match-story row displays sensibly in the timeline/detail.
  const headline = (body.title ?? "").trim().slice(0, 120) || segments[0]!.headline?.trim() || `Match Story · ${segments.length} beats`;
  const startTime = segments[0]!.startTime;
  const endTime = segments[segments.length - 1]!.endTime;
  const repUrl = segments[0]!.youtubeUrl ?? "";

  const [clip] = await db
    .insert(clipsTable)
    .values({
      youtubeUrl: repUrl, startTime, endTime, headline, mode: "edited", frameStyle, sourceChannel,
      captionsEnabled, captionColor, outroEnabled, narrationScript, voiceoverVoice, voiceoverSpeed,
      jobType: "matchstory", segments, sourceType: "youtube", status: "pending",
    })
    .returning();

  if (!clip) { res.status(500).json({ error: "Failed to create Match Story" }); return; }

  res.status(201).json(GetClipResponse.parse(clip));

  const outputFilename = `clip_${clip.id}_${Date.now()}.mp4`;
  dispatchMatchStoryJob(clip.id, outputFilename, frameStyle, sourceChannel, captionsEnabled, outroEnabled, captionColor, narrationScript, segments, voiceoverVoice, voiceoverSpeed, headline, transitionsEnabled, titleCardEnabled);
});

/**
 * POST /clips/matchstory/verify — check each beat's timestamp actually exists in its source
 * video (Gemini's timestamps are guesses). Mirrors /clips/top5/verify but beats have no rank,
 * so results are keyed by array `index`. Read-only; sequential to stay light on the phone.
 */
router.post("/clips/matchstory/verify", async (req, res): Promise<void> => {
  const body = req.body as { segments?: unknown };
  const raw = Array.isArray(body.segments) ? body.segments : [];
  if (raw.length === 0) { res.status(400).json({ error: "No beats to verify." }); return; }
  const timeRe = /^\d{1,2}:\d{2}(:\d{2})?$/;
  const toHMS = (t: string) => { const p = t.split(":"); while (p.length < 3) p.unshift("00"); return p.slice(-3).map((x) => x.padStart(2, "0")).join(":"); };
  type Suggestion = { startTime: string; endTime: string; confidence: number; evidence: string };
  const results: { index: number; ok: boolean; reason: string | null; message: string | null; videoDuration: number | null; suggested: Suggestion | null }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = (raw[i] ?? {}) as Record<string, unknown>;
    const url = String(s.youtubeUrl ?? "").trim();
    const st = String(s.startTime ?? "").trim();
    const en = String(s.endTime ?? "").trim();
    if (!url || !timeRe.test(st) || !timeRe.test(en)) {
      results.push({ index: i, ok: false, reason: "invalid", message: "Add a source URL and valid start/end times.", videoDuration: null, suggested: null });
      continue;
    }
    const startTime = toHMS(st), endTime = toHMS(en), normUrl = normalizeYoutubeUrl(url);
    try {
      const r = await validateSegmentWithinVideo(normUrl, startTime, endTime);
      let suggested: Suggestion | null = null;
      if (!r.ok && r.videoDuration && r.videoDuration > 0) {
        // Out of range — try to auto-locate the real timestamp from the transcript (no AI call).
        const cues = await fetchTranscriptCues(normUrl);
        const reqDur = Math.max(6, timeToSeconds(endTime) - timeToSeconds(startTime));
        suggested = locateMomentInTranscript(cues, String(s.headline ?? ""), String(s.narrationLine ?? ""), reqDur, r.videoDuration);
      }
      results.push({ index: i, ok: r.ok, reason: r.reason ?? null, message: r.message ?? null, videoDuration: r.videoDuration ?? null, suggested });
    } catch {
      results.push({ index: i, ok: true, reason: null, message: null, videoDuration: null, suggested: null });
    }
  }
  res.json({ results });
});

/**
 * Enqueues a TOP 5 job: render each ranked moment (possibly from its own source URL),
 * stitch them behind a title card with #5→#1 badges, caption once, then add a
 * countdown voiceover. Mirrors dispatchStoryJob's status handling.
 */
function dispatchTop5Job(
  clipId: number,
  outputFilename: string,
  title: string,
  frameStyle: "standard" | "immersive",
  sourceChannel: string,
  captionsEnabled: boolean,
  outroEnabled: boolean,
  captionColor: string,
  order: "5to1" | "1to5",
  segments: Top5Segment[],
  voiceoverVoice = "",
  voiceoverSpeed = ""
) {
  const { channelHandle } = readSettings();
  enqueueClipJob(async () => {
    try {
      await db.update(clipsTable).set({ status: "processing" }).where(eq(clipsTable.id, clipId)).execute();
    } catch (err: unknown) {
      logger.error({ err, clipId }, "Failed to mark Top 5 as processing");
    }
    await processTop5(outputFilename, title, channelHandle, clipId, frameStyle, sourceChannel, captionsEnabled, outroEnabled, captionColor, order, segments, { voice: voiceoverVoice, speed: voiceoverSpeed })
      .then(async () => {
        await db.update(clipsTable).set({ status: "done", progress: 100, outputFilename }).where(eq(clipsTable.id, clipId));
      })
      .catch(async (err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err);
        // processTop5's per-moment / pre-flight errors are already clean, user-facing, and name the
        // failing moment — pass them through verbatim (parseProcessingError would strip them because
        // they can contain a URL that matches its noise filter).
        const msg = raw.startsWith("Moment #") ? raw.slice(0, 400) : parseProcessingError(raw);
        await db.update(clipsTable).set({ status: "error", progress: 0, errorMessage: msg }).where(eq(clipsTable.id, clipId));
      });
  });
}

/**
 * Normalises + validates a raw Top 5 moments array. Each moment needs a rank, a
 * start/end time, and a source URL — for single-source jobs the per-moment URL is
 * blank and we fall back to `jobUrl`. Broken rows are dropped.
 */
function sanitizeTop5Segments(raw: unknown, jobUrl: string): Top5Segment[] {
  if (!Array.isArray(raw)) return [];
  const timeRe = /^\d{1,2}:\d{2}(:\d{2})?$/;
  const toHMS = (t: string) => { const p = t.split(":"); while (p.length < 3) p.unshift("00"); return p.slice(-3).map((x) => x.padStart(2, "0")).join(":"); };
  const fallback = jobUrl.trim() ? normalizeYoutubeUrl(jobUrl.trim()) : "";
  const out: Top5Segment[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const seg = s as Record<string, unknown>;
    const st = String(seg.startTime ?? "").trim();
    const en = String(seg.endTime ?? "").trim();
    if (!timeRe.test(st) || !timeRe.test(en)) continue;
    const rank = Number(seg.rank);
    if (!Number.isFinite(rank) || rank < 1) continue;
    const rawUrl = String(seg.youtubeUrl ?? "").trim();
    const segUrl = rawUrl ? normalizeYoutubeUrl(rawUrl) : fallback;
    if (!segUrl) continue;
    out.push({
      rank: Math.round(rank),
      youtubeUrl: segUrl,
      startTime: toHMS(st),
      endTime: toHMS(en),
      headline: String(seg.headline ?? "").slice(0, 120),
      sourceChannel: String(seg.sourceChannel ?? "").slice(0, 80),
      narrationLine: String(seg.narrationLine ?? "").slice(0, 600),
      zoomMoments: typeof seg.zoomMoments === "string" ? seg.zoomMoments : "",
      punchInEnabled: seg.punchInEnabled === true,
    });
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * POST /clips/top5/verify — check each moment's timestamp actually exists in its source
 * video (Gemini's timestamps are guesses). Read-only; runs sequentially to stay light on
 * the phone. Returns per-rank { ok, message, videoDuration } so the UI can flag bad rows.
 */
router.post("/clips/top5/verify", async (req, res): Promise<void> => {
  const body = req.body as { youtubeUrl?: string; segments?: unknown };
  const segments = sanitizeTop5Segments(body.segments, body.youtubeUrl ?? "");
  if (segments.length === 0) {
    res.status(400).json({ error: "No valid moments to verify." });
    return;
  }
  type Suggestion = { startTime: string; endTime: string; confidence: number; evidence: string };
  const results: { rank: number; ok: boolean; reason: string | null; message: string | null; videoDuration: number | null; suggested: Suggestion | null }[] = [];
  for (const seg of segments) {
    try {
      const r = await validateSegmentWithinVideo(seg.youtubeUrl!, seg.startTime, seg.endTime);
      let suggested: Suggestion | null = null;
      if (!r.ok && r.videoDuration && r.videoDuration > 0) {
        // Gemini's timestamp is out of range — try to auto-locate the real one from the
        // transcript (deterministic keyword match, no AI call). null → the UI offers a
        // targeted "re-ask Gemini" prompt instead.
        const cues = await fetchTranscriptCues(seg.youtubeUrl!);
        const reqDur = Math.max(6, timeToSeconds(seg.endTime) - timeToSeconds(seg.startTime));
        suggested = locateMomentInTranscript(cues, seg.headline ?? "", seg.narrationLine ?? "", reqDur, r.videoDuration);
      }
      results.push({ rank: seg.rank, ok: r.ok, reason: r.reason ?? null, message: r.message ?? null, videoDuration: r.videoDuration ?? null, suggested });
    } catch {
      results.push({ rank: seg.rank, ok: true, reason: null, message: null, videoDuration: null, suggested: null });
    }
  }
  res.json({ results });
});

/**
 * POST /clips/top5 — create a Top 5 countdown job. `youtubeUrl` is the optional
 * single-source fallback; multi-source jobs put a URL on each moment instead.
 */
router.post("/clips/top5", async (req, res): Promise<void> => {
  const body = req.body as {
    title?: string; youtubeUrl?: string; frameStyle?: string; sourceChannel?: string;
    captionsEnabled?: boolean; outroEnabled?: boolean; captionColor?: string;
    order?: string; segments?: unknown;
    voiceoverVoice?: string; voiceoverSpeed?: string;
  };
  const segments = sanitizeTop5Segments(body.segments, body.youtubeUrl ?? "");
  if (segments.length < 2) {
    res.status(400).json({ error: "A Top 5 needs at least 2 moments (each with a rank, a source URL, and a start/end time)." });
    return;
  }

  const title = (body.title ?? "").trim().slice(0, 120) || `Top ${segments.length}`;
  const frameStyle = (body.frameStyle === "standard" ? "standard" : "immersive") as "standard" | "immersive";
  const sourceChannel = body.sourceChannel ?? "";
  const captionsEnabled = body.captionsEnabled ?? true;
  const outroEnabled = body.outroEnabled ?? true;
  const captionColor = body.captionColor ?? "";
  const order = (body.order === "1to5" ? "1to5" : "5to1") as "5to1" | "1to5";
  const voiceoverVoice = body.voiceoverVoice ?? "";
  const voiceoverSpeed = body.voiceoverSpeed ?? "";

  // Representative fields so the row displays sensibly in the timeline/detail.
  const playOrder = [...segments].sort((a, b) => (order === "1to5" ? a.rank - b.rank : b.rank - a.rank));
  const startTime = playOrder[0]!.startTime;
  const endTime = playOrder[playOrder.length - 1]!.endTime;
  const repUrl = playOrder[0]!.youtubeUrl ?? "";

  const [clip] = await db
    .insert(clipsTable)
    .values({
      youtubeUrl: repUrl, startTime, endTime, headline: title, mode: "edited", frameStyle, sourceChannel,
      captionsEnabled, captionColor, outroEnabled, narrationScript: "", voiceoverVoice, voiceoverSpeed,
      jobType: "top5", segments, sourceType: "youtube", status: "pending",
    })
    .returning();

  if (!clip) { res.status(500).json({ error: "Failed to create Top 5" }); return; }

  res.status(201).json(GetClipResponse.parse(clip));

  const outputFilename = `clip_${clip.id}_${Date.now()}.mp4`;
  dispatchTop5Job(clip.id, outputFilename, title, frameStyle, sourceChannel, captionsEnabled, outroEnabled, captionColor, order, segments, voiceoverVoice, voiceoverSpeed);
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
  const voiceoverVoice = (req.body as { voiceoverVoice?: string }).voiceoverVoice ?? "";
  const voiceoverSpeed = (req.body as { voiceoverSpeed?: string }).voiceoverSpeed ?? "";

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
    .values({ youtubeUrl, startTime, endTime, headline, mode, frameStyle, sourceChannel, captionsEnabled, captionColor, voiceoverEnabled, voiceoverHook, voiceoverMode, narrationScript, voiceoverVoice, voiceoverSpeed, punchInEnabled, zoomMoments, outroEnabled, sourceType: "youtube", status: "pending" })
    .returning();

  if (!clip) {
    res.status(500).json({ error: "Failed to create clip" });
    return;
  }

  res.status(201).json(GetClipResponse.parse(clip));

  const outputFilename = `clip_${clip.id}_${Date.now()}.mp4`;
  dispatchClipJob(clip.id, youtubeUrl, startTime, endTime, headline, outputFilename, mode, frameStyle, undefined, sourceChannel, captionsEnabled, outroEnabled, voiceoverEnabled, voiceoverHook, punchInEnabled, zoomMoments, captionColor, voiceoverMode, narrationScript, voiceoverVoice, voiceoverSpeed);
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
  let voiceoverVoice = "";
  let voiceoverSpeed = "";
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
    if (name === "voiceoverVoice") voiceoverVoice = value;
    if (name === "voiceoverSpeed") voiceoverSpeed = value;
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
            voiceoverVoice,
            voiceoverSpeed,
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
        dispatchClipJob(clip.id, null, startTime, endTime, headline, outputFilename, mode, frameStyle, savedFilePath, sourceChannel, captionsEnabled, outroEnabled, voiceoverEnabled, voiceoverHook, punchInEnabled, zoomMoments, captionColor, voiceoverMode, narrationScript, voiceoverVoice, voiceoverSpeed);
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

  // Match Story retry: re-render the whole multi-source montage from persisted beats + narration.
  if (clip.jobType === "matchstory") {
    dispatchMatchStoryJob(
      clip.id,
      outputFilename,
      clipFrameStyle,
      clip.sourceChannel ?? "",
      clip.captionsEnabled ?? true,
      clip.outroEnabled ?? true,
      clip.captionColor ?? "",
      clip.narrationScript ?? "",
      (clip.segments ?? []) as StorySegment[],
      clip.voiceoverVoice ?? "",
      clip.voiceoverSpeed ?? "",
      clip.headline ?? "",
    );
    return;
  }

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
      clip.voiceoverVoice ?? "",
      clip.voiceoverSpeed ?? "",
    );
    return;
  }

  // Top 5 retry: re-render the whole countdown from the persisted moments. Order isn't
  // stored separately, so retries default to 5→1 (the default and by far the common case).
  if (clip.jobType === "top5") {
    dispatchTop5Job(
      clip.id,
      outputFilename,
      clip.headline ?? "Top 5",
      clipFrameStyle,
      clip.sourceChannel ?? "",
      clip.captionsEnabled ?? true,
      clip.outroEnabled ?? true,
      clip.captionColor ?? "",
      "5to1",
      (clip.segments ?? []) as Top5Segment[],
      clip.voiceoverVoice ?? "",
      clip.voiceoverSpeed ?? "",
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
    clip.narrationScript ?? "",
    clip.voiceoverVoice ?? "",
    clip.voiceoverSpeed ?? ""
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
