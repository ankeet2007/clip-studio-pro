import { Router, type IRouter } from "express";
import path from "path";
import os from "os";
import fs from "fs";
import { spawn } from "child_process";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Piper voices installed on the phone (~/piper/*.onnx). This is an ALLOWLIST: a preview
// request for anything else is rejected, so `:voice` can never be used for path traversal
// or to spawn Piper on an arbitrary model. Keep in sync with KNOWN_VOICES in clipProcessor
// and VOICE_OPTIONS in the frontend home page.
const KNOWN_VOICES = new Set([
  "en_GB-alan-medium",
  "en_US-joe-medium",
  "en_US-norman-medium",
  "en_GB-northern_english_male-medium",
  "en_US-hfc_male-medium",
  "en_US-ryan-medium",
  "en_US-lessac-medium",
]);

// One short line auditioned for every voice, so the samples are directly comparable. Spoken
// at normal pace (1.0) — a preview is about the voice's character, not the chosen pace.
const SAMPLE_TEXT =
  "This is a preview of your A.I. voiceover. Let's make your next clip go viral.";

// Cached samples live in their own dir (NOT the render output dir, so clip cleanup never
// touches them). First request per voice synthesises + caches; later requests serve the file.
const SAMPLE_DIR = path.join(os.homedir(), "myapp", "voice_samples");
const VOICE_SCRIPT = path.join(os.homedir(), "myapp", "scripts", "generate_voiceover.sh");

// De-dupe concurrent first-time generations of the same voice (rapid double-clicks) so we
// only ever spawn one Piper process per voice at a time.
const inFlight = new Map<string, Promise<string | null>>();

function samplePath(voice: string): string {
  return path.join(SAMPLE_DIR, `${voice}.wav`);
}

function isPlayable(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).size > 1024;
  } catch {
    return false;
  }
}

// Synthesises the sample WAV for `voice` via the same local Piper script the render pipeline
// uses. Resolves the cached file path, or null if generation failed. Writes to a temp file
// and renames on success, so a killed synth never leaves a half-written cache entry.
async function generateSample(voice: string): Promise<string | null> {
  const outWav = samplePath(voice);
  if (isPlayable(outWav)) return outWav;
  if (!fs.existsSync(VOICE_SCRIPT)) {
    logger.warn({ VOICE_SCRIPT }, "Voice sample: voiceover script missing");
    return null;
  }
  try {
    fs.mkdirSync(SAMPLE_DIR, { recursive: true });
  } catch (err) {
    logger.warn({ err }, "Voice sample: could not create cache dir");
    return null;
  }
  const tmp = path.join(SAMPLE_DIR, `.${voice}.${Date.now()}.tmp.wav`);
  return await new Promise<string | null>((resolve) => {
    const p = spawn("bash", [VOICE_SCRIPT, SAMPLE_TEXT, tmp, voice, "1.0"], { timeout: 90_000 });
    let out = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", (err) => {
      logger.warn({ err, voice }, "Voice sample: spawn failed");
      resolve(null);
    });
    p.on("close", () => {
      try {
        if (isPlayable(tmp)) {
          fs.renameSync(tmp, outWav);
          resolve(outWav);
        } else {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
          logger.warn({ voice, out: out.trim() }, "Voice sample: no audio produced");
          resolve(null);
        }
      } catch (err) {
        logger.warn({ err, voice }, "Voice sample: finalize failed");
        resolve(null);
      }
    });
  });
}

// GET /api/voices/preview/:voice — streams back a short WAV sample of the given Piper voice
// so the user can audition it before choosing. Cheap after the first hit (cached on disk).
router.get("/voices/preview/:voice", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.voice) ? req.params.voice[0] : req.params.voice;
  const voice = (raw ?? "").trim();
  if (!KNOWN_VOICES.has(voice)) {
    res.status(400).json({ error: "Unknown voice" });
    return;
  }

  const send = (filePath: string): void => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("audio/wav");
    res.sendFile(filePath);
  };

  const cached = samplePath(voice);
  if (isPlayable(cached)) {
    send(cached);
    return;
  }

  let job = inFlight.get(voice);
  if (!job) {
    job = generateSample(voice).finally(() => inFlight.delete(voice));
    inFlight.set(voice, job);
  }
  const outPath = await job;
  if (!outPath) {
    res.status(500).json({ error: "Could not generate voice sample" });
    return;
  }
  send(outPath);
});

export default router;
