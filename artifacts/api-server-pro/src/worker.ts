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
      j.transitionsEnabled !== false, j.titleCardEnabled === true);
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

// Async transcribe jobs (understand_video's cloud path, medium.en). Kept separate from render jobs.
const trJobs = new Map<string, { status: "running" | "done" | "error"; transcript?: string; error?: string }>();
const ttsJobs = new Map<string, { status: "running" | "done" | "error"; wavBase64?: string; error?: string }>();

/**
 * Pick the best whisper model actually PRESENT on this box.
 *
 * The old hardcoded default was `ggml-medium.en.bin`, but colab-boot.sh installs the
 * quantised `ggml-medium.en-q5_0.bin` — so on a Colab worker the default pointed at a file
 * that does not exist and every transcribe job failed with a bare "Command failed", which
 * reads like a crash rather than a missing model. Prefer sharper models first and fall back
 * to whatever is installed.
 */
function resolveWhisperModel(): string {
  const dir = path.join(os.homedir(), "whisper.cpp/models");
  const preferred = [
    "ggml-medium.en.bin",
    "ggml-medium.en-q5_0.bin",
    "ggml-small.en.bin",
    "ggml-base.en.bin",
    "ggml-tiny.en.bin",
  ];
  for (const m of preferred) {
    const p = path.join(dir, m);
    try { if (fs.existsSync(p)) return p; } catch { /* */ }
  }
  return path.join(dir, "ggml-medium.en.bin"); // nothing found — fail with the canonical name
}

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

    ws.on("finish", () => {
      const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const outName = `worker_${jobId}.mp4`;
      const clipId = Math.floor(Math.random() * 1_000_000) + 1; // truthy -> captions + voiceover run
      jobs.set(jobId, { status: "rendering", mode: "edited" });
      // Respond IMMEDIATELY with the jobId; render in the background (async, beats proxy timeouts
      // so long 3-5 min single clips render on the cloud instead of falling back to local).
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jobId }));
      const started = Date.now();
      processClip(
        p.youtubeUrl || "", p.startTime || "00:00:00", p.endTime || "00:00:00", p.headline || "",
        outName, p.mode || "edited", p.channelHandle || "", clipId, tmpIn, p.frameStyle || "immersive",
        p.sourceChannel || "", p.captionsEnabled !== false, !!p.outroEnabled, !!p.voiceoverEnabled,
        p.voiceoverHook || "", !!p.punchInEnabled, p.zoomMoments || "", p.captionColor || "",
        p.voiceoverMode || "hook", p.narrationScript || "",
        { voice: p.voiceoverVoice || "en_US-lessac-medium", speed: p.voiceoverSpeed || "1.0" },
      )
        .then(() => {
          const outPath = path.join(getOutputDir(), outName);
          const rec = jobs.get(jobId);
          if (!rec) return;
          if (fs.existsSync(outPath)) {
            rec.status = "done"; rec.outPath = outPath; rec.seconds = (Date.now() - started) / 1000;
            console.log(`[worker] render ${jobId} done in ${rec.seconds.toFixed(1)}s`);
          } else { rec.status = "error"; rec.error = "render produced no output"; }
        })
        .catch((e: any) => {
          const rec = jobs.get(jobId);
          if (rec) { rec.status = "error"; rec.error = String(e?.message || e); }
          console.error(`[worker] render ${jobId} failed:`, e?.message || e);
        })
        .finally(() => { try { fs.unlinkSync(tmpIn); } catch { /* */ } });
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
          // Cut-engine assets were bundled as basenames alongside localFile — re-absolutize them into
          // the extract dir the same way, or the cloud render can't find the filler/punchline clips.
          ...(Array.isArray(s.fillerAssets)
            ? { fillerAssets: s.fillerAssets.map((f: string) => path.join(extractDir, path.basename(f))) }
            : {}),
          ...(s.punchline && s.punchline.asset
            ? { punchline: { word: s.punchline.word, asset: path.join(extractDir, path.basename(s.punchline.asset)) } }
            : {}),
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

  // POST /worker/transcribe-job -> body = raw 16kHz-mono WAV ; returns { jobId } immediately and runs
  // whisper medium.en in the BACKGROUND (far sharper than the phone's tiny.en). ASYNC on purpose: a
  // full minute of audio on medium.en can take minutes, which would blow a proxy's ~100s response
  // timeout — so the phone submits then polls, and longer clips are NEVER rejected on a timeout.
  if (req.method === "POST" && url === "/worker/transcribe-job") {
    if (!SECRET || req.headers["x-worker-secret"] !== SECRET) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      req.resume();
      return;
    }
    const wavPath = path.join(os.tmpdir(), `wk_tr_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
    const ws = fs.createWriteStream(wavPath);
    req.pipe(ws);
    ws.on("error", () => { try { res.writeHead(500); res.end("upload error"); } catch { /* */ } });
    ws.on("finish", () => {
      const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      trJobs.set(jobId, { status: "running" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jobId }));
      const bin = process.env.WORKER_WHISPER_BIN || path.join(os.homedir(), "whisper.cpp/build/bin/whisper-cli");
      const model = process.env.WORKER_WHISPER_MODEL || resolveWhisperModel();
      const ofPrefix = wavPath.replace(/\.wav$/, "");
      const started = Date.now();
      // Generous ceiling (a few minutes) so even a long clip's medium.en pass completes; the phone's
      // poll deadline is longer still, so the timeout never rejects a legitimately long transcription.
      execFile(bin, ["-m", model, "-f", wavPath, "-nt", "-np", "-otxt", "-of", ofPrefix, "-t", "4"],
        { timeout: 280_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LD_LIBRARY_PATH: `${path.dirname(bin)}:${process.env.LD_LIBRARY_PATH || ""}` } },
        (err) => {
          let transcript = "";
          try { transcript = fs.readFileSync(`${ofPrefix}.txt`, "utf8").replace(/\s+/g, " ").trim(); } catch { /* */ }
          try { fs.unlinkSync(wavPath); } catch { /* */ }
          try { fs.unlinkSync(`${ofPrefix}.txt`); } catch { /* */ }
          const rec = trJobs.get(jobId);
          if (rec) {
            if (err && !transcript) { rec.status = "error"; rec.error = String(err.message || err); }
            else { rec.status = "done"; rec.transcript = transcript; }
          }
          console.log(`[worker] transcribe ${jobId} ${err && !transcript ? "failed" : "done"} in ${((Date.now() - started) / 1000).toFixed(1)}s (${transcript.length} chars)`);
          setTimeout(() => trJobs.delete(jobId), 120_000);
        });
    });
    return;
  }

  // POST /worker/tts-job -> body = JSON { text, voice?, speed? } ; returns { jobId } and runs
  // Piper in the BACKGROUND. Exists so PRONUNCIATION WORK NEVER TOUCHES THE PHONE: the phone
  // (armv7, low RAM) OOM-kills batched Piper+whisper probes and takes sshd down with them, so
  // measuring a name respelling there costs an hour and usually dies. Deliberately shells out
  // to the SAME scripts/generate_voiceover.sh the renderer uses, so what we measure is exactly
  // what a render will speak — a separate Piper invocation here could drift from production.
  if (req.method === "POST" && url === "/worker/tts-job") {
    if (!SECRET || req.headers["x-worker-secret"] !== SECRET) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      req.resume();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { body += c; if (body.length > 200_000) req.destroy(); });
    req.on("end", () => {
      let text = "", voice = "en_US-ryan-medium", speed = "1.0";
      try {
        const j = JSON.parse(body || "{}") as { text?: string; voice?: string; speed?: string | number };
        text = String(j.text ?? "").trim();
        if (j.voice) voice = String(j.voice);
        if (j.speed != null && j.speed !== "") speed = String(j.speed);
      } catch { /* fall through to the empty-text check */ }
      if (!text) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "text is required" }));
        return;
      }
      const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      ttsJobs.set(jobId, { status: "running" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jobId }));

      const outWav = path.join(os.tmpdir(), `wk_tts_${jobId}.wav`);
      const script = path.join(os.homedir(), "myapp/scripts/generate_voiceover.sh");
      const started = Date.now();
      execFile("bash", [script, text, outWav, voice, speed], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err) => {
        const rec = ttsJobs.get(jobId);
        let wavBase64 = "";
        try { if (fs.existsSync(outWav)) wavBase64 = fs.readFileSync(outWav).toString("base64"); } catch { /* */ }
        try { fs.unlinkSync(outWav); } catch { /* */ }
        if (rec) {
          if (!wavBase64) { rec.status = "error"; rec.error = String(err?.message || "piper produced no audio"); }
          else { rec.status = "done"; rec.wavBase64 = wavBase64; }
        }
        console.log(`[worker] tts ${jobId} ${wavBase64 ? "done" : "failed"} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        setTimeout(() => ttsJobs.delete(jobId), 120_000);
      });
    });
    return;
  }

  // GET /worker/tts-job/<id> -> { status, wavBase64?, error? }
  if (req.method === "GET" && url.startsWith("/worker/tts-job/")) {
    if (!SECRET || req.headers["x-worker-secret"] !== SECRET) {
      res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return;
    }
    const rec = ttsJobs.get(url.slice("/worker/tts-job/".length));
    if (!rec) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unknown job" })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: rec.status, wavBase64: rec.wavBase64, error: rec.error }));
    return;
  }

  // GET /worker/transcribe-job/<id> -> { status, transcript?, error? }
  if (req.method === "GET" && url.startsWith("/worker/transcribe-job/")) {
    if (!SECRET || req.headers["x-worker-secret"] !== SECRET) {
      res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return;
    }
    const jobId = url.slice("/worker/transcribe-job/".length);
    const rec = trJobs.get(jobId);
    if (!rec) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unknown job" })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: rec.status, transcript: rec.transcript, error: rec.error }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "0.0.0.0", () => console.log(`[worker] listening on :${PORT}`));
