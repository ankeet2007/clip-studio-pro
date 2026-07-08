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
import { processClip, getOutputDir } from "./lib/clipProcessor";

const PORT = Number(process.env.PORT || 7860);
const SECRET = process.env.WORKER_SECRET || "";

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

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "0.0.0.0", () => console.log(`[worker] listening on :${PORT}`));
