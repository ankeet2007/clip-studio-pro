// Standalone render worker (for the GitHub Codespace / any beefy box).
//
// Reuses the EXACT phone render pipeline (processClip) so output is identical, but runs
// on a fast CPU with lots of RAM. Zero web deps (raw node:http) on purpose. The phone
// downloads the segment on its home IP, POSTs it here, we render + return the finished MP4.
//
// Contract:
//   GET  /health                      -> { ok: true }
//   POST /worker/render               -> body = raw video bytes (the downloaded segment)
//        headers: x-worker-secret: <shared secret>   (required)
//                 x-params: <base64 of a JSON params object>
//        returns: the finished MP4 (video/mp4 attachment) or { error } JSON on failure.
//
// A truthy clipId is passed so captions + voiceover run (processClip gates them on clipId);
// all DB writes inside processClip are best-effort/try-caught, so a dummy DATABASE_URL is fine.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { processClip, processStory, processTop5, processMatchStory, getOutputDir } from "./lib/clipProcessor";

function extractTar(tarPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tar", ["-xf", tarPath, "-C", destDir], (err) => (err ? reject(err) : resolve()));
  });
}

// Run a bundled multi-segment job (story / top5 / matchstory) whose segment.localFile paths
// have already been rewritten to absolute extracted files.
async function runBundledJob(mode: string, j: any, segments: any[], outName: string): Promise<void> {
  const clipId = Math.floor(Math.random() * 1_000_000) + 1; // truthy → captions/narration run
  if (mode === "story") {
    await processStory(j.youtubeUrl || "", outName, j.channelHandle || "", clipId, j.frameStyle || "immersive",
      j.sourceChannel || "", j.captionsEnabled !== false, !!j.outroEnabled, j.captionColor || "",
      j.narrationScript || "", segments, j.voiceOpts || {});
  } else if (mode === "top5") {
    await processTop5(outName, j.title || "", j.channelHandle || "", clipId, j.frameStyle || "immersive",
      j.sourceChannel || "", j.captionsEnabled !== false, !!j.outroEnabled, j.captionColor || "",
      j.order === "1to5" ? "1to5" : "5to1", segments, j.voiceOpts || {});
  } else if (mode === "matchstory") {
    await processMatchStory(outName, j.channelHandle || "", clipId, j.frameStyle || "immersive",
      j.sourceChannel || "", j.captionsEnabled !== false, !!j.outroEnabled, j.captionColor || "",
      j.narrationScript || "", segments, j.voiceOpts || {}, j.title || "",
      j.transitionsEnabled !== false, j.titleCardEnabled !== false);
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
}

const PORT = Number(process.env.PORT || 7860);
const SECRET = process.env.WORKER_SECRET || "";

// In-flight async multi-segment jobs. The submit request returns a jobId immediately and the
// render runs in the BACKGROUND, so a proxy's response-timeout (cloudflared ~100s) never kills
// a long render — the phone polls status then downloads the result (all short requests).
type JobRec = { status: "rendering" | "done" | "error"; outPath?: string; error?: string; mode?: string; seconds?: number };
const jobs = new Map<string, JobRec>();

function decodeParams(h: string | string[] | undefined): Record<string, unknown> {
  try { return JSON.parse(Buffer.from(String(h || ""), "base64").toString("utf8") || "{}"); }
  catch { return {}; }
}

const server = http.createServer((req, res) => {
  const url = req.url || "";

  if (req.method === "GET" && (url === "/health" || url === "/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, worker: "clip-render" }));
    return;
  }

  // GET /worker/job/<id>  -> status JSON ;  GET /worker/job/<id>/result -> the finished MP4
  if (req.method === "GET" && url.startsWith("/worker/job/")) {
    if (!SECRET || req.headers["x-worker-secret"] !== SECRET) {
      res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return;
    }
    const rest = url.slice("/worker/job/".length);
    const wantResult = rest.endsWith("/result");
    const jobId = wantResult ? rest.slice(0, -"/result".length) : rest;
    const job = jobs.get(jobId);
    if (!job) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unknown job" })); return; }
    if (!wantResult) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: job.status, error: job.error, seconds: job.seconds, mode: job.mode }));
      return;
    }
    if (job.status !== "done" || !job.outPath || !fs.existsSync(job.outPath)) {
      res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not ready", status: job.status }));
      return;
    }
    const size = fs.statSync(job.outPath).size;
    res.writeHead(200, { "content-type": "video/mp4", "content-length": String(size), "content-disposition": `attachment; filename="${jobId}.mp4"` });
    const rs = fs.createReadStream(job.outPath);
    rs.pipe(res);
    rs.on("close", () => { try { fs.unlinkSync(job.outPath!); } catch { /* */ } jobs.delete(jobId); });
    return;
  }

  if (req.method === "POST" && url === "/worker/render") {
    if (!SECRET || req.headers["x-worker-secret"] !== SECRET) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      req.resume();
      return;
    }

    const p = decodeParams(req.headers["x-params"]) as Record<string, any>;
    const tmpIn = path.join(os.tmpdir(), `wk_in_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    const ws = fs.createWriteStream(tmpIn);
    req.pipe(ws);
    ws.on("error", () => { try { res.writeHead(500); res.end("upload error"); } catch { /* */ } });

    ws.on("finish", async () => {
      const clipId = Math.floor(Math.random() * 1_000_000) + 1; // truthy -> captions + voiceover run
      const outName = `worker_${clipId}.mp4`;
      const started = Date.now();
      try {
        await processClip(
          p.youtubeUrl || "",
          p.startTime || "00:00:00",
          p.endTime || "00:00:00",
          p.headline || "",
          outName,
          p.mode || "edited",
          p.channelHandle || "",
          clipId,
          tmpIn,                               // localFilePath -> skips download
          p.frameStyle || "immersive",
          p.sourceChannel || "",
          p.captionsEnabled !== false,
          !!p.outroEnabled,
          !!p.voiceoverEnabled,
          p.voiceoverHook || "",
          !!p.punchInEnabled,
          p.zoomMoments || "",
          p.captionColor || "",
          p.voiceoverMode || "hook",
          p.narrationScript || "",
          { voice: p.voiceoverVoice || "en_US-lessac-medium", speed: p.voiceoverSpeed || "1.0" },
        );
        const outPath = path.join(getOutputDir(), outName);
        if (!fs.existsSync(outPath)) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "render produced no output" }));
          try { fs.unlinkSync(tmpIn); } catch { /* */ }
          return;
        }
        const size = fs.statSync(outPath).size;
        console.log(`[worker] rendered ${outName} (${(size / 1e6).toFixed(1)}MB) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        res.writeHead(200, {
          "content-type": "video/mp4",
          "content-length": String(size),
          "x-render-seconds": String(((Date.now() - started) / 1000).toFixed(1)),
          "content-disposition": `attachment; filename="${outName}"`,
        });
        const rs = fs.createReadStream(outPath);
        rs.pipe(res);
        rs.on("close", () => { try { fs.unlinkSync(outPath); } catch { /* */ } try { fs.unlinkSync(tmpIn); } catch { /* */ } });
      } catch (e: any) {
        try { fs.unlinkSync(tmpIn); } catch { /* */ }
        console.error("[worker] render failed:", e?.message || e);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e?.message || e) }));
      }
    });
    return;
  }

  if (req.method === "POST" && url === "/worker/render-job") {
    if (!SECRET || req.headers["x-worker-secret"] !== SECRET) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      req.resume();
      return;
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wkjob_"));
    const tarPath = path.join(workDir, "bundle.tar");
    const ws = fs.createWriteStream(tarPath);
    req.pipe(ws);
    ws.on("error", () => { try { res.writeHead(500); res.end("upload error"); } catch { /* */ } });
    ws.on("finish", async () => {
      const extractDir = path.join(workDir, "x");
      try {
        fs.mkdirSync(extractDir, { recursive: true });
        await extractTar(tarPath, extractDir);
        const job = JSON.parse(fs.readFileSync(path.join(extractDir, "job.json"), "utf8"));
        const segments = (job.segments || []).map((s: any) => ({
          ...s,
          localFile: s.localFile ? path.join(extractDir, path.basename(s.localFile)) : undefined,
        }));
        const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const outName = `job_${jobId}.mp4`;
        jobs.set(jobId, { status: "rendering", mode: job.mode });
        // Respond IMMEDIATELY with the jobId; render in the background (beats proxy timeouts).
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jobId }));
        const started = Date.now();
        runBundledJob(job.mode, job.jobSpec || {}, segments, outName)
          .then(() => {
            const outPath = path.join(getOutputDir(), outName);
            const rec = jobs.get(jobId);
            if (!rec) return;
            if (fs.existsSync(outPath)) {
              rec.status = "done"; rec.outPath = outPath; rec.seconds = (Date.now() - started) / 1000;
              console.log(`[worker] job ${jobId} (${job.mode}) done in ${rec.seconds.toFixed(1)}s`);
            } else { rec.status = "error"; rec.error = "job produced no output"; }
          })
          .catch((e: any) => {
            const rec = jobs.get(jobId);
            if (rec) { rec.status = "error"; rec.error = String(e?.message || e); }
            console.error(`[worker] job ${jobId} failed:`, e?.message || e);
          })
          .finally(() => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ } });
      } catch (e: any) {
        console.error("[worker] job submit failed:", e?.message || e);
        try { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(e?.message || e) })); } catch { /* */ }
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
      }
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "0.0.0.0", () => console.log(`[worker] listening on :${PORT}`));
