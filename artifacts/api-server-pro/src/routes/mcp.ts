// Remote MCP connector for the Claude app — a thin, read-only bridge onto the Match Story 2.0
// clip-scout. Speaks the MCP "Streamable HTTP" transport (JSON-RPC 2.0 over POST /mcp) so it can
// be added as a custom connector in the Claude web/mobile app (Customize -> Connectors).
//
// Hand-rolled (no SDK dependency) because the build is dependency-constrained. Stateless: every
// POST is self-contained, no Mcp-Session-Id, no server-initiated SSE. It only exposes SEARCH +
// REVIEW tools that proxy the existing /api/scout endpoints in-process over localhost — it can
// never download a clip or start a render, so exposing it publicly is low-risk.

import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import { understandVideo } from "../lib/videoUnderstand";

const SERVER_INFO = { name: "clip-studio-scout", version: "1.0.0" };
// Protocol versions we understand; we echo the client's if it's one of these, else use the latest.
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = "2025-06-18";
const PLATFORMS = ["reddit", "x", "instagram", "facebook"] as const;

// The connector doubles as a STORY DIRECTOR: these instructions carry the whole method for
// turning scattered social clips into one narrated "story" montage (Clip Studio's Match Story
// 2.0). The render mutes each clip's own audio and speaks ONLY your narration, so the narration
// alone must carry the story — and each clip must SHOW the exact moment its line describes.
const INSTRUCTIONS = [
  "You are a story-driven narrator + director for short-form football/sports videos. Your tools",
  "search Reddit, X (Twitter), Instagram and Facebook for real video clips (`search_clips`), and",
  "WATCH a clip to see what actually happens in it (`understand_video` -> keyframes + transcript).",
  "`list_platforms` shows usable platforms; `get_scout_results` re-polls a running search. Read-only",
  "-- nothing is downloaded/rendered here; you hand the user a plan they paste into Clip Studio.",
  "",
  "GOAL: ONE tight vertical Short, 60-80 SECONDS (never over ~1:20), where the AI VOICEOVER tells the",
  "FULL story of what happened -- in detail, start to finish -- and the clips play UNDER it as short",
  "background B-roll (auto-cut to the narration; clip audio is muted). The narration is the STAR; the",
  "clips just show what is being described. Length = the narration length, so the narration must carry it.",
  "",
  "METHOD -- follow in order:",
  "1. RESEARCH THE WHOLE STORY FIRST. Before writing anything, work out what ACTUALLY happened -- the",
  "   full sequence: the setup, the key moments IN ORDER, the turning point, the result, the drama. Use",
  "   `search_clips` to find footage and `understand_video` on SEVERAL clips (read their transcripts +",
  "   see the frames) to gather the real facts from MULTIPLE sources: names, numbers, minute marks, the",
  "   score, who did what. Do NOT start writing until you understand the complete story.",
  "2. WRITE THE FULL NARRATION. Write ONE continuous narration that TELLS THE WHOLE STORY in detail --",
  "   setup -> key moments in order -> turning point -> payoff. Storyteller voice: specific, names +",
  "   numbers, cause->effect, a little tension. It must stand on its own (clips are muted). TARGET",
  "   ~150-190 words TOTAL ~= 60-80 seconds spoken. This total IS the video length, so keep it tight --",
  "   detailed but zero filler/hype padding.",
  "3. SPLIT INTO BEATS + PICK B-ROLL. Break the narration into 5-8 beats (about one or two sentences",
  "   each). For EACH beat pick a clip (confirmed via `understand_video`) that VISUALLY MATCHES what",
  "   that beat describes -- it plays as short background B-roll cut to that beat's narration length, so",
  "   it only needs to show the right action clearly. Reject blurry/zoomed-logo/static/ambiguous clips.",
  "",
  "OUTPUT -- when the user asks you to build it, return EXACTLY this and nothing else (fields separated",
  "by ' | ', one line per beat, in story order):",
  "TITLE: <4-7 word title>",
  "SEGMENTS:",
  "<real clip url from search_clips> | <channel/handle> | <on-screen headline, 3-6 words> | <this beat's chunk of the narration>",
  "...",
  "",
  "Only use URLs that `search_clips` returned and `understand_video` could open -- never invent a link.",
  "Keep the TOTAL narration ~60-80s (the clips are cut to fit it). Example beat line:",
  "https://www.reddit.com/r/soccer/comments/abc/ | r/soccer | Egypt Break The Deadlock | Twenty-three minutes in, Egypt catch them cold: a quick counter, one-nil, and the underdogs are suddenly dreaming.",
].join("\n");

// ---------------------------------------------------------------------------
// Local scout API client (calls this same server over loopback).
// ---------------------------------------------------------------------------

function baseUrl(): string {
  const port = process.env["PORT"] || "3001";
  return `http://127.0.0.1:${port}/api`;
}

async function apiFetch(path: string, init?: RequestInit): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(`${baseUrl()}${path}`, { ...init, signal: ctrl.signal });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new Error(json?.error || `scout API ${path} -> HTTP ${res.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tool definitions (JSON Schema) + implementations.
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "list_platforms",
    description:
      "List which social platforms (Reddit, X, Instagram, Facebook) the clip scout can currently " +
      "search, based on the cookies/credentials configured on the server.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_clips",
    description:
      "Search Reddit, X (Twitter), Instagram and Facebook for the best video clips about a topic, " +
      "ranked by relevance + engagement + recency + quality. Returns candidate clips with title, " +
      "platform, author, score, engagement, duration, source URL and thumbnail. Read-only: it does " +
      "NOT download anything. If the search is still running when it returns, call get_scout_results " +
      "with the returned jobId for the rest.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "What to search for, e.g. 'Argentina vs Cape Verde red card'." },
        platforms: {
          type: "array",
          items: { type: "string", enum: [...PLATFORMS] },
          description: "Which platforms to search. Omit to search all configured platforms.",
        },
        maxCandidates: { type: "number", description: "Max clips to return (10-80, default 30)." },
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    name: "get_scout_results",
    description:
      "Fetch the current status/results of a clip search by its jobId. Use when search_clips " +
      "returned a partial result that was still in progress.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string", description: "The jobId returned by search_clips." } },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "understand_video",
    description:
      "Watch/understand a single video from a Reddit, X (Twitter), Instagram or Facebook URL. " +
      "Downloads the clip and returns evenly-spaced KEYFRAME IMAGES plus a transcript of the " +
      "spoken audio/commentary — look at the frames and read the transcript to describe what " +
      "actually happens in the clip. Pairs with search_clips: find a link, then understand it. " +
      "May take up to ~50s; on long clips only the first 60s of audio is transcribed.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The video URL (reddit.com/redd.it, x.com/twitter.com, instagram.com, or facebook.com)." },
        frames: { type: "number", description: "How many keyframes to return (1-8, default 5)." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

function renderJob(job: any): string {
  const cands: any[] = Array.isArray(job?.candidates) ? job.candidates : [];
  let header: string;
  if (job?.status === "ready") header = `Found ${cands.length} clip${cands.length === 1 ? "" : "s"} for "${job.topic}".`;
  else if (job?.status === "error") header = `Search error: ${job.message || "unknown error"}.`;
  else header = `Still searching (${Math.round(job?.progress || 0)}%) — ${cands.length} clip${cands.length === 1 ? "" : "s"} so far. Call get_scout_results with jobId "${job?.id}" for the rest.`;

  if (cands.length === 0 && job?.status === "ready") {
    return `${header}\n\nNo matching video clips found. Try a broader topic, add platforms, or check the platform cookies on the server.`;
  }

  const lines = cands.map((c, i) => {
    const dur = c.durationSec ? ` · ${Math.round(c.durationSec)}s` : "";
    const thumb = c.thumbUrl ? `\n   thumb: ${c.thumbUrl}` : "";
    const why = Array.isArray(c.reasons) && c.reasons.length ? `\n   why: ${c.reasons.join(", ")}` : "";
    return `${i + 1}. [${c.platform}] score ${c.score} — ${c.title || "(no title)"}\n   by ${c.author} · ${c.engagement} engagement${dur}\n   ${c.sourceUrl}${thumb}${why}`;
  });
  return `${header}\n\n${lines.join("\n\n")}`;
}

async function runListPlatforms(): Promise<string> {
  const data = await apiFetch("/scout/adapters");
  const adapters: { platform: string; configured: boolean }[] = data?.adapters ?? [];
  const on = adapters.filter((a) => a.configured).map((a) => a.platform);
  const off = adapters.filter((a) => !a.configured).map((a) => a.platform);
  const parts = [`Usable now: ${on.length ? on.join(", ") : "(none)"}.`];
  if (off.length) parts.push(`Not configured (needs a cookie/credentials on the server): ${off.join(", ")}.`);
  return parts.join(" ");
}

async function runSearchClips(args: any): Promise<string> {
  const topic = String(args?.topic ?? "").trim();
  if (topic.length < 2) throw new Error("Provide a topic to search for (at least 2 characters).");
  const platforms = Array.isArray(args?.platforms)
    ? args.platforms.filter((p: unknown): p is string => (PLATFORMS as readonly string[]).includes(p as string))
    : undefined;
  const maxCandidates = Math.min(80, Math.max(10, Number(args?.maxCandidates) || 30));

  const job = await apiFetch("/scout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, platforms, maxCandidates }),
  });
  const jobId = job?.id;
  if (!jobId) throw new Error("Scout did not start (no job id returned).");

  // Poll internally, but bounded well under the connector's request timeout. The scout streams
  // candidates as each platform returns, so a partial poll still yields useful early results;
  // anything unfinished is handed back as a jobId for get_scout_results.
  let cur = job;
  const deadline = Date.now() + 24_000;
  while (Date.now() < deadline && cur.status !== "ready" && cur.status !== "error") {
    await sleep(1500);
    cur = await apiFetch(`/scout/${encodeURIComponent(jobId)}`);
  }
  logger.info({ jobId, topic, status: cur.status, count: cur.candidates?.length ?? 0 }, "MCP search_clips");
  return renderJob(cur);
}

async function runGetResults(args: any): Promise<string> {
  const jobId = String(args?.jobId ?? "").trim();
  if (!jobId) throw new Error("Provide the jobId returned by search_clips.");
  const job = await apiFetch(`/scout/${encodeURIComponent(jobId)}`);
  return renderJob(job);
}

type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface ToolResult { content: ContentBlock[]; isError?: boolean }

const textResult = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

async function runUnderstandVideo(args: any): Promise<ToolResult> {
  const url = String(args?.url ?? "").trim();
  if (!url) throw new Error("Provide a video URL (Reddit, X, Instagram or Facebook).");
  const u = await understandVideo(url, Number(args?.frames) || 5);
  const res = u.width ? ` · ${u.width}x${u.height}` : "";
  const lines = [`Video from ${u.platform} · ${Math.round(u.durationSec)}s${res}.`];
  if (u.transcript) lines.push(`\nSpoken/commentary transcript${u.transcriptTruncated ? " (first 60s)" : ""}:\n${u.transcript}`);
  else lines.push("\nNo speech transcript (the clip is silent or transcription was unavailable).");
  if (u.notes.length) lines.push(`\nNotes: ${u.notes.join("; ")}`);
  lines.push(`\n[${u.frames.length} keyframe image(s) attached below, evenly spaced across the clip — read them to see what happens.]`);
  const content: ContentBlock[] = [{ type: "text", text: lines.join("\n") }];
  for (const f of u.frames) content.push({ type: "image", data: f.dataBase64, mimeType: f.mimeType });
  return { content };
}

async function callTool(name: string, args: any): Promise<ToolResult> {
  switch (name) {
    case "list_platforms": return textResult(await runListPlatforms());
    case "search_clips": return textResult(await runSearchClips(args));
    case "get_scout_results": return textResult(await runGetResults(args));
    case "understand_video": return runUnderstandVideo(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 dispatch.
// ---------------------------------------------------------------------------

interface RpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: any }

/** Handle one JSON-RPC message. Returns a response object, or null for notifications. */
async function handleRpc(msg: RpcMessage): Promise<any | null> {
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
        return null; // notifications get no response
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        const r = await callTool(msg.params?.name, msg.params?.arguments ?? {});
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
    // Tool failures are reported in-band (isError) so the model can see/recover from them;
    // everything else is a JSON-RPC protocol error.
    if (method === "tools/call" && !isNotification) {
      logger.warn({ e, tool: msg.params?.name }, "MCP tool error");
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${message}` }], isError: true } };
    }
    if (isNotification) return null;
    return { jsonrpc: "2.0", id, error: { code: -32603, message } };
  }
}

// ---------------------------------------------------------------------------
// Express router (mounted at /mcp).
// ---------------------------------------------------------------------------

const router: IRouter = Router();

router.post("/", async (req: Request, res: Response): Promise<void> => {
  const body = req.body;
  try {
    if (Array.isArray(body)) {
      const out: any[] = [];
      for (const m of body) { const r = await handleRpc(m); if (r) out.push(r); }
      if (out.length === 0) { res.status(202).end(); return; }
      res.status(200).json(out);
      return;
    }
    if (!body || typeof body !== "object") {
      res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const r = await handleRpc(body);
    if (!r) { res.status(202).end(); return; }
    res.status(200).json(r);
  } catch (e) {
    logger.error({ e }, "MCP POST failed");
    res.status(500).json({ jsonrpc: "2.0", id: (body && body.id) ?? null, error: { code: -32603, message: "Internal error" } });
  }
});

// Stateless server: no server-initiated SSE stream and no sessions to terminate.
router.get("/", (_req: Request, res: Response): void => {
  res.set("Allow", "POST").status(405).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method Not Allowed. Use POST for MCP messages." } });
});
router.delete("/", (_req: Request, res: Response): void => { res.status(200).end(); });

export default router;
