// Second remote MCP connector — "Clip Studio STORY Mode 2.0" — mounted at /story-mcp on the SAME
// api-server-pro process. Because it rides the already-running app (and its permanent ngrok tunnel),
// it survives restarts and its URL never rotates — unlike a standalone process + cloudflared quick
// tunnel. SEPARATE connector from routes/mcp.ts (the Scout/discovery connector): Scout FINDS + VERIFIES
// clips; THIS one RENDERS them into a finished Match Story 2.0 video. Hand-rolled Streamable-HTTP
// JSON-RPC (zero deps, stateless), mirroring routes/mcp.ts. Proxies the app's own HTTP API over loopback.

import { Router, type IRouter, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger";
import { getUploadsDir, getOutputFilePath } from "../lib/clipProcessor";

// HH:MM:SS (or seconds) -> seconds.
const hmsToSec = (t: unknown): number => {
  const p = String(t ?? "").split(":").map(Number);
  if (p.length === 3) return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
  if (p.length === 2) return (p[0] || 0) * 60 + (p[1] || 0);
  return Number(t) || 0;
};

const SERVER_INFO = { name: "clip-studio-story", version: "1.0.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = "2025-06-18";

const INSTRUCTIONS = [
  "ROLE: This connector RENDERS a finished Match Story 2.0 video (a vertical narrated montage) from clips",
  "you have ALREADY found + verified with the Clip Studio Scout connector. It does not search — Scout does.",
  "",
  "FLOW: Scout (search_clips + understand_video) finds and verifies ONE real clip per beat and you write ONE",
  "narration line per beat -> validate_story (confirms a real 60-90s, ~150-220 words, 4-8 beats) ->",
  "create_match_story (downloads the clips + enqueues the render, returns a clipId) -> get_story(clipId)",
  "(poll until status is 'done', then open the downloadUrl).",
  "",
  "Each segment = a REAL source URL from Scout (reddit/x/instagram/facebook/youtube) OR an uploads path from",
  "Scout's download_clip / extract_segment, PLUS the beat's narration line. The render MUTES every clip's own",
  "audio and speaks ONLY your narration, cutting each clip to its line — so the narration carries the whole",
  "story and must be a real 60-90s (150-220 words) across 4-8 beats, in play order (beat 1 = hook, last = payoff).",
  "",
  "CLIP LENGTH: give each beat a clip about 1.3x its narration length (a ~10s line wants a ~13s clip). The",
  "render trims each clip to its line but WON'T stretch a short clip, so a clip shorter than its narration",
  "freezes/bleeds at the tail. If your extract_segment window is too short, re-cut it a few seconds longer.",
  "",
  "VOICE: leave voice unset for the default warm British narrator (en_GB-alan-medium) at natural pace, or",
  "pass voice/pace to override.",
  "",
  "HARD NAMES: if a name would be mispronounced by the TTS, spell the beat's `narration` PHONETICALLY",
  "(e.g. 'day-KETT-el-ah-reh') and put the correctly-spelled version in `caption` (same word count) — the",
  "voice then says it right while the on-screen captions stay correct.",
].join("\n");

// ---- Loopback client to this same app's HTTP API ----
function baseUrl(): string {
  const port = process.env["PORT"] || "3001";
  return `http://127.0.0.1:${port}/api`;
}

async function apiFetch(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}${path}`, { ...init, signal: ctrl.signal });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new Error(json?.error || `Clip Studio API ${path} -> HTTP ${res.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

const countWords = (s: string) => String(s || "").trim().split(/\s+/).filter(Boolean).length;
const totalWords = (segs: any[]) => segs.reduce((a, s) => a + countWords(s.narration), 0);

function resolvePace(pace: any): string {
  if (pace == null || pace === "") return "";
  const n = Number(pace);
  if (Number.isFinite(n)) return String(Math.min(1.6, Math.max(0.7, n)));
  const key = String(pace).toLowerCase();
  if (key.startsWith("slow")) return "1.3";
  if (key.startsWith("slight")) return "1.15";
  return "1.0";
}

const SEGMENT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "The beat's source: a real clip URL from Scout (reddit/x/instagram/facebook/youtube) OR an uploads path from Scout's download_clip / extract_segment." },
    narration: { type: "string", description: "This beat's SPOKEN narration line (the render voices this over the muted clip). May be phonetic for hard names (e.g. 'day-KETT-el-ah-reh') to fix TTS pronunciation." },
    caption: { type: "string", description: "Optional on-screen CAPTION text when it must differ from what's spoken — the correctly-spelled version (e.g. 'De Ketelaere'). Use the SAME word count as narration so the captions line up. Omit to caption exactly what's spoken." },
    headline: { type: "string", description: "Optional short on-screen headline for this beat (3-6 words)." },
    channel: { type: "string", description: "Optional source handle/credit, e.g. r/soccer." },
  },
  required: ["url", "narration"],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: "validate_story",
    description:
      "Pre-flight check a Match Story script BEFORE rendering: totals the narration words across all beats and " +
      "confirms it will make a real 60-90s Short (~150-220 words, 4-8 beats). Call this right before " +
      "create_match_story; if it reports too short/long, fix the narration first. Read-only, renders nothing.",
    inputSchema: {
      type: "object",
      properties: { segments: { type: "array", items: SEGMENT_SCHEMA, description: "The beats, in play order." } },
      required: ["segments"],
      additionalProperties: false,
    },
  },
  {
    name: "create_match_story",
    description:
      "Render a finished Match Story 2.0 video from verified clips. Downloads each beat's clip into the render " +
      "pipeline (uploads paths from Scout's download_clip/extract_segment are used as-is and render fastest), " +
      "enqueues the render, and returns a clipId to poll with get_story. Pass 2-8 segments (each a real Scout " +
      "clip URL or uploads path + a narration line), in play order. The server rejects a script under ~140 words.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "4-7 word title (shown on the title card)." },
        segments: { type: "array", items: SEGMENT_SCHEMA, description: "The beats, in play order (2-8)." },
        voice: { type: "string", description: "Optional Piper voice id (e.g. en_GB-alan-medium, en_US-joe-medium). Omit to use the default warm British narrator (en_GB-alan-medium)." },
        pace: { type: "string", description: "Narration pace: 'normal' (default, natural human speed), 'slightly-slow', 'slow', or a Piper length_scale 0.7-1.6." },
        captions: { type: "boolean", description: "Burn karaoke captions (default true)." },
        titleCard: { type: "boolean", description: "Show the opening title card (default true)." },
        outro: { type: "boolean", description: "Show the outro card (default true)." },
        crossfades: { type: "boolean", description: "Crossfade between beats (default true)." },
        captionColor: { type: "string", description: "Hex color for the karaoke caption highlight, e.g. #FFF400 (default, bright yellow)." },
      },
      required: ["segments"],
      additionalProperties: false,
    },
  },
  {
    name: "get_story",
    description:
      "Poll a Match Story render by its clipId (returned by create_match_story). Returns status " +
      "(pending/processing/done/error), progress %, and — when status is 'done' — a downloadUrl for the MP4.",
    inputSchema: {
      type: "object",
      properties: { clipId: { type: "number", description: "The clipId returned by create_match_story." } },
      required: ["clipId"],
      additionalProperties: false,
    },
  },
];

interface ToolResult { content: { type: "text"; text: string }[]; isError?: boolean }
const textResult = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

function normSegments(raw: any): any[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s: any) => ({
      url: String(s?.url ?? "").trim(),
      narration: String(s?.narration ?? "").trim(),
      caption: String(s?.caption ?? "").trim(),
      headline: String(s?.headline ?? "").trim(),
      channel: String(s?.channel ?? "").trim(),
    }))
    .filter((s) => s.url && s.narration);
}

function validateStoryText(segments: any[]): string {
  const words = totalWords(segments);
  const secs = Math.round(words / 2.4);
  const n = segments.length;
  const problems: string[] = [];
  if (n < 2) problems.push(`only ${n} beat(s) — need at least 2 (aim 4-8)`);
  if (n > 8) problems.push(`${n} beats — the render uses the first 8, so trim to <=8`);
  if (words < 150) problems.push(`~${words} words (~${secs}s) is under the 150-word / 60s floor (server hard-rejects under ~140) — lengthen the beats`);
  else if (words > 220) problems.push(`~${words} words (~${secs}s) is over the 220-word / 90s ceiling — trim it`);
  const ok = n >= 2 && n <= 8 && words >= 150 && words <= 220;
  const head = ok
    ? `Ready to render: ${n} beats · ~${words} words · ~${secs}s (inside the 60-90s target).`
    : `Not ideal yet: ${n} beats · ~${words} words · ~${secs}s.`;
  const detail = problems.length ? `\nFix:\n- ${problems.join("\n- ")}` : "";
  const perBeat = segments
    .map((s, i) => `  ${i + 1}. (${countWords(s.narration)}w) ${s.narration.slice(0, 70)}${s.narration.length > 70 ? "…" : ""}`)
    .join("\n");
  return `${head}${detail}\n\nPer beat:\n${perBeat}`;
}

async function runValidateStory(args: any): Promise<ToolResult> {
  const segments = normSegments(args?.segments);
  if (segments.length === 0) throw new Error("Provide segments, each with a url and a narration line.");
  return textResult(validateStoryText(segments));
}

async function runCreateMatchStory(args: any): Promise<ToolResult> {
  const segments = normSegments(args?.segments);
  if (segments.length < 2) throw new Error("Provide at least 2 segments (each a clip url/uploads path + a narration line).");
  const words = totalWords(segments);
  if (words < 140) throw new Error(`Narration is only ~${words} words (~${Math.round(words / 2.4)}s) — a Story needs ~150-220 words (60-90s). Lengthen the beats, then retry.`);

  // 1) Download each beat's clip into the render pipeline (uploads paths are reused, not re-downloaded).
  const items = segments.slice(0, 8).map((s) => ({ url: s.url, headline: s.headline, sourceChannel: s.channel, narrationLine: s.narration }));
  const fetched = await apiFetch("/scout/fetch-urls", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
  }, 150_000);
  const beats: any[] = Array.isArray(fetched?.beats) ? fetched.beats : [];
  if (beats.length < 2) {
    throw new Error(`Only ${beats.length} of ${items.length} clips could be fetched (the rest may be full-highlight/watch URLs or blocked). In Scout, extract_segment each moment into an uploads path, then pass those paths.`);
  }

  // 2) Enqueue the render. Re-attach each beat's optional CAPTION (P4) — beats come back from
  // fetch-urls keyed only on narration, so map caption by the (normalized) spoken line.
  const norm = (t: string) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 600);
  const capByLine = new Map<string, string>();
  segments.forEach((s) => { if (s.caption) capByLine.set(norm(s.narration), s.caption); });
  const body = {
    title: String(args?.title ?? "").slice(0, 120),
    frameStyle: "immersive",
    captionsEnabled: args?.captions !== false,
    titleCardEnabled: args?.titleCard !== false,
    outroEnabled: args?.outro !== false,
    transitionsEnabled: args?.crossfades !== false,
    captionColor: /^#?[0-9a-fA-F]{6}$/.test(String(args?.captionColor ?? "")) ? String(args?.captionColor).replace(/^#?/, "#") : "#FFF400",
    // Default to a warm, natural British narrator at normal (1.0) pace — human, not robotic. Callers
    // can override with `voice` / `pace`.
    voiceoverVoice: String(args?.voice || "en_GB-alan-medium"),
    voiceoverSpeed: resolvePace(args?.pace ?? "normal"),
    segments: beats.map((b) => ({
      sourceType: "local", localFile: b.localFile,
      startTime: b.startTime, endTime: b.endTime,
      headline: b.headline, sourceChannel: b.sourceChannel, narrationLine: b.narrationLine,
      captionLine: capByLine.get(norm(b.narrationLine)) || "",
    })),
  };
  const clip = await apiFetch("/clips/matchstory", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }, 30_000);
  const id = clip?.id;
  if (!id) throw new Error("Render was not enqueued (no clip id returned).");
  logger.info({ clipId: id, beats: beats.length, words }, "story-mcp create_match_story");

  // P5 (freeze check) + P7 (cross-beat dedupe) — non-blocking pre-finish warnings surfaced to the caller.
  const warnings: string[] = [];
  const seen = new Map<string, number>();
  segments.forEach((s, i) => {
    const k = s.url.trim();
    if (!k) return;
    if (seen.has(k)) warnings.push(`beats ${seen.get(k)! + 1} & ${i + 1} reuse the SAME source (${k.slice(0, 48)}…) — that shot repeats`);
    else seen.set(k, i);
  });
  beats.forEach((b: any, i: number) => {
    const clipDur = hmsToSec(b.endTime) - hmsToSec(b.startTime);
    const voSec = countWords(b.narrationLine || "") / 2.4;
    if (clipDur > 0 && voSec > 0 && clipDur < voSec * 1.3) {
      warnings.push(`beat ${i + 1} clip is ~${clipDur.toFixed(1)}s but its line is ~${voSec.toFixed(1)}s of speech (want a clip ≥${(voSec * 1.3).toFixed(1)}s) — may freeze/bleed; re-extract a longer window`);
    }
  });
  const warnBlock = warnings.length ? `\n\nHeads-up before it finishes:\n- ${warnings.join("\n- ")}` : "";

  return textResult(
    `Match Story enqueued — clipId ${id} (${beats.length} beats, ~${words} words ~${Math.round(words / 2.4)}s).\n` +
    `Poll it with get_story({ clipId: ${id} }) until status is "done", then open the downloadUrl.` + warnBlock
  );
}

async function runGetStory(args: any, publicOrigin: string): Promise<ToolResult> {
  const id = Number(args?.clipId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Provide the numeric clipId returned by create_match_story.");
  const clip = await apiFetch(`/clips/${id}`);
  const status = clip?.status ?? "unknown";
  const progress = clip?.progress ?? 0;
  // P7 — explicit terminal states so the caller can branch cleanly.
  if (status === "done") {
    // P3 — copy the finished render into the uploads dir so a sandboxed client (that can't reach the
    // download tunnel) can understand_video it back to self-QC captions/frames.
    let selfQc = "";
    try {
      const src = clip.outputFilename ? getOutputFilePath(clip.outputFilename) : "";
      if (src && fs.existsSync(src)) {
        const dest = path.join(getUploadsDir(), `render_${id}.mp4`);
        fs.copyFileSync(src, dest);
        selfQc = `\nSelf-QC: understand_video "${dest}" to inspect the finished render (frames + transcript).`;
      }
    } catch (e) { logger.warn({ e, id }, "story-mcp render self-QC copy failed"); }
    return textResult(`clipId ${id} — status: done (100%).\nDownload: ${publicOrigin}/api/clips/${id}/download${selfQc}`);
  }
  if (status === "error") return textResult(`clipId ${id} — status: failed.\nError: ${clip?.errorMessage || "render failed (no error message)"}.`);
  return textResult(`clipId ${id} — status: processing (${progress}%). Poll get_story again in ~15-30s.`);
}

async function callTool(name: string, args: any, publicOrigin: string): Promise<ToolResult> {
  switch (name) {
    case "validate_story": return runValidateStory(args);
    case "create_match_story": return runCreateMatchStory(args);
    case "get_story": return runGetStory(args, publicOrigin);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

interface RpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: any }

async function handleRpc(msg: RpcMessage, publicOrigin: string): Promise<any | null> {
  const id = msg?.id;
  const method = msg?.method;
  const isNotification = id === undefined || id === null;
  try {
    let result: any;
    switch (method) {
      case "initialize": {
        const reqProto = msg.params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(reqProto) ? reqProto : DEFAULT_PROTOCOL;
        result = { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
        break;
      }
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/roots/list_changed":
        return null;
      case "ping": result = {}; break;
      case "tools/list": result = { tools: TOOLS }; break;
      case "tools/call": {
        const r = await callTool(msg.params?.name, msg.params?.arguments ?? {}, publicOrigin);
        result = { content: r.content, isError: r.isError ?? false };
        break;
      }
      default:
        if (isNotification) return null;
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
    if (isNotification) return null;
    return { jsonrpc: "2.0", id, result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (method === "tools/call" && !isNotification) {
      logger.warn({ e, tool: msg.params?.name }, "story-mcp tool error");
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${message}` }], isError: true } };
    }
    if (isNotification) return null;
    return { jsonrpc: "2.0", id, error: { code: -32603, message } };
  }
}

const router: IRouter = Router();

function originOf(req: Request): string {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0]!.trim();
  const host = req.headers.host;
  return host ? `${proto}://${host}` : baseUrl().replace("/api", "");
}

router.post("/", async (req: Request, res: Response): Promise<void> => {
  const body = req.body;
  const publicOrigin = originOf(req);
  try {
    if (Array.isArray(body)) {
      const out: any[] = [];
      for (const m of body) { const r = await handleRpc(m, publicOrigin); if (r) out.push(r); }
      if (out.length === 0) { res.status(202).end(); return; }
      res.status(200).json(out);
      return;
    }
    if (!body || typeof body !== "object") {
      res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const r = await handleRpc(body, publicOrigin);
    if (!r) { res.status(202).end(); return; }
    res.status(200).json(r);
  } catch (e) {
    logger.error({ e }, "story-mcp POST failed");
    res.status(500).json({ jsonrpc: "2.0", id: (body && body.id) ?? null, error: { code: -32603, message: "Internal error" } });
  }
});

router.get("/", (_req: Request, res: Response): void => {
  res.set("Allow", "POST").status(405).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method Not Allowed. Use POST for MCP messages." } });
});
router.delete("/", (_req: Request, res: Response): void => { res.status(200).end(); });

export default router;
