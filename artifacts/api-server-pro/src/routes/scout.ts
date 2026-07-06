// Match Story 2.0 — clip-scout routes. On-demand: start a scout, poll candidates, keep/drop,
// then hand the kept clips to the Match Story beat editor. Job state is in memory (scout service).

import { Router, type IRouter } from "express";
import fs from "fs";
import { startScout, getScoutJob, setCandidateStatus, buildBeatsFromJob, listAdapters } from "../lib/scout";
import type { Platform, ScoutJob, ScoutOptions } from "../lib/scout/types";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const ALL_PLATFORMS: Platform[] = ["reddit", "x", "instagram", "facebook"];

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
      durationSec: c.durationSec,
      width: c.width ?? null,
      height: c.height ?? null,
      score: Math.round(c.scores.total * 100),
      reasons: c.reasons,
      status: c.status,
      thumbUrl: c.thumbFile ? `/api/scout/${job.id}/thumb/${c.id}` : (c.thumbnail ?? null),
    })),
  };
}

// POST /scout — start a scout run.
router.post("/scout", (req, res): void => {
  const body = req.body as { topic?: string; platforms?: string[]; subreddits?: string[]; maxDownload?: number };
  const topic = (body.topic ?? "").trim();
  if (topic.length < 2) { res.status(400).json({ error: "Enter a topic to scout for." }); return; }
  const platforms = (Array.isArray(body.platforms) ? body.platforms : ALL_PLATFORMS).filter((p): p is Platform => (ALL_PLATFORMS as string[]).includes(p));
  const opts: ScoutOptions = {
    platforms: platforms.length ? platforms : ["reddit"],
    subreddits: Array.isArray(body.subreddits) ? body.subreddits.slice(0, 6).map(String) : undefined,
    maxDownload: Math.min(12, Math.max(2, Number(body.maxDownload) || 8)),
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

// POST /scout/:id/approve — build Match Story beats from the KEPT candidates.
router.post("/scout/:id/approve", (req, res): void => {
  const beats = buildBeatsFromJob(req.params.id);
  if (beats.length < 2) { res.status(400).json({ error: "Keep at least 2 clips before building beats." }); return; }
  res.json({ beats });
});

// GET /scout/:id/thumb/:candId — serve a candidate's locally extracted thumbnail.
router.get("/scout/:id/thumb/:candId", (req, res): void => {
  const job = getScoutJob(req.params.id);
  const c = job?.candidates.find((x) => x.id === req.params.candId);
  if (!c?.thumbFile || !fs.existsSync(c.thumbFile)) { res.status(404).end(); return; }
  res.sendFile(c.thumbFile);
});

export default router;
