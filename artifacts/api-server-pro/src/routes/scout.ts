// Match Story 2.0 — clip-scout routes. On-demand: start a scout, poll candidates, keep/drop,
// then hand the kept clips to the Match Story beat editor. Job state is in memory (scout service).

import { Router, type IRouter } from "express";
import fs from "fs";
import { startScout, getScoutJob, setCandidateStatus, buildBeatsFromJob, buildBeatsFromUrls, listAdapters } from "../lib/scout";
import type { Platform, ScoutJob, ScoutOptions } from "../lib/scout/types";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const ALL_PLATFORMS: Platform[] = ["reddit", "x", "instagram", "facebook", "youtube"];

// Strip filesystem paths from a job before returning it; expose a thumbUrl instead.
function publicJob(job: ScoutJob) {
  return {
    id: job.id,
    topic: job.topic,
    status: job.status,
    progress: job.progress,
    message: job.message ?? null,
    candidates: job.candidates.map((c) => ({
      id: c.id,
      platform: c.platform,
      title: c.title,
      author: c.author,
      sourceUrl: c.sourceUrl,
      engagement: c.engagement,
      durationSec: c.durationSec ?? null,
      width: null,
      height: null,
      score: Math.round(c.scores.total * 100),
      reasons: c.reasons,
      status: c.status,
      thumbUrl: c.thumbnail ?? null,
      createdAt: c.createdAt > 0 ? c.createdAt : null, // unix seconds (null = unknown, e.g. YT flat search)
    })),
  };
}

// POST /scout — start a scout run.
router.post("/scout", (req, res): void => {
  const body = req.body as { topic?: string; platforms?: string[]; subreddits?: string[]; maxCandidates?: number; maxAgeHours?: number; minDurationSec?: number };
  const topic = (body.topic ?? "").trim();
  if (topic.length < 2) { res.status(400).json({ error: "Enter a topic to scout for." }); return; }
  const platforms = (Array.isArray(body.platforms) ? body.platforms : ALL_PLATFORMS).filter((p): p is Platform => (ALL_PLATFORMS as string[]).includes(p));
  const maxAgeHours = Number(body.maxAgeHours);
  const minDurationSec = Number(body.minDurationSec);
  const opts: ScoutOptions = {
    platforms: platforms.length ? platforms : ["reddit"],
    subreddits: Array.isArray(body.subreddits) ? body.subreddits.slice(0, 6).map(String) : undefined,
    maxCandidates: Math.min(200, Math.max(10, Number(body.maxCandidates) || 40)),
    maxPerPlatform: 100,
    maxAgeHours: Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : undefined,
    minDurationSec: Number.isFinite(minDurationSec) && minDurationSec > 0 ? minDurationSec : undefined,
  };
  const job = startScout(topic, opts);
  logger.info({ jobId: job.id, topic, platforms: opts.platforms }, "Scout started");
  res.status(201).json(publicJob(job));
});

// GET /scout/adapters — which platforms are usable right now.
router.get("/scout/adapters", (_req, res): void => {
  res.json({ adapters: listAdapters() });
});

// GET /scout/:id — poll a scout job.
router.get("/scout/:id", (req, res): void => {
  const job = getScoutJob(req.params.id);
  if (!job) { res.status(404).json({ error: "Scout job not found (it may have expired)." }); return; }
  res.json(publicJob(job));
});

// POST /scout/:id/candidate — keep/drop a candidate.
router.post("/scout/:id/candidate", (req, res): void => {
  const body = req.body as { candId?: string; status?: string };
  const status = body.status === "drop" ? "drop" : "keep";
  const ok = setCandidateStatus(req.params.id, String(body.candId ?? ""), status);
  if (!ok) { res.status(404).json({ error: "Candidate not found." }); return; }
  res.json({ ok: true });
});

// POST /scout/:id/approve — download the KEPT candidates now, then build Match Story beats.
router.post("/scout/:id/approve", async (req, res): Promise<void> => {
  const beats = await buildBeatsFromJob(req.params.id);
  if (beats.length < 2) { res.status(400).json({ error: "Keep at least 2 clips (that download successfully) before building." }); return; }
  res.json({ beats });
});

// POST /scout/fetch-urls — Match Story 2.0 (Claude-driven): download a pasted list of social clip
// URLs (the beats Claude picked via the MCP connector) into local Match Story beats.
router.post("/scout/fetch-urls", async (req, res): Promise<void> => {
  const body = req.body as { items?: { url?: string; headline?: string; sourceChannel?: string; narrationLine?: string }[]; minShortSide?: number; minBitsPerPixel?: number };
  const items = (Array.isArray(body.items) ? body.items : [])
    .filter((x) => x && typeof x.url === "string" && x.url.trim())
    .map((x) => ({ url: String(x.url).trim(), headline: String(x.headline ?? ""), sourceChannel: String(x.sourceChannel ?? ""), narrationLine: String(x.narrationLine ?? "") }))
    .slice(0, 8);
  if (items.length < 2) { res.status(400).json({ error: "Provide at least 2 clip URLs (Reddit / X / Instagram / Facebook)." }); return; }
  // Sharpness floor is on by default; callers can lower it (or pass 0 to disable) when a topic
  // genuinely has no HD footage and soft B-roll beats no B-roll.
  const minShortSide = Number.isFinite(body.minShortSide as number) && (body.minShortSide as number) >= 0
    ? Math.min(2160, Number(body.minShortSide)) : undefined;
  const minBitsPerPixel = Number.isFinite(body.minBitsPerPixel as number) && (body.minBitsPerPixel as number) >= 0
    ? Math.min(1, Number(body.minBitsPerPixel)) : undefined;
  try {
    const { beats, rejected } = await buildBeatsFromUrls(items, { minShortSide, minBitsPerPixel });
    if (beats.length < 2) {
      const softCount = rejected.filter((r) => r.reason.startsWith("too soft") || r.reason.startsWith("too small")).length;
      res.status(400).json({
        error: softCount > 0
          ? `Only ${beats.length} clip(s) cleared the sharpness floor — ${softCount} were too low-resolution to use. Pick sharper sources, or retry with a lower minShortSide.`
          : "Couldn't download at least 2 of those clips — the platform cookies may be missing/expired, or the links aren't downloadable videos.",
        rejected,
      });
      return;
    }
    logger.info({ requested: items.length, got: beats.length, rejected: rejected.length }, "MS2 fetch-urls");
    res.json({ beats, rejected });
  } catch (e) {
    logger.error({ e }, "MS2 fetch-urls failed");
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to fetch clips." });
  }
});

export default router;
