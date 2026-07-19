// Remote MCP connector for the Claude app — a thin, read-only bridge onto the Match Story 2.0
// clip-scout. Speaks the MCP "Streamable HTTP" transport (JSON-RPC 2.0 over POST /mcp) so it can
// be added as a custom connector in the Claude web/mobile app (Customize -> Connectors).
//
// Hand-rolled (no SDK dependency) because the build is dependency-constrained. Stateless: every
// POST is self-contained, no Mcp-Session-Id, no server-initiated SSE. It exposes SEARCH + REVIEW
// tools (proxying /api/scout in-process) PLUS download_clip / extract_segment, which fetch/trim a
// real file into the uploads dir so a verified clip lands in the render pipeline. Writes are
// confined to the uploads dir (generated filenames); it still never TRIGGERS a render — the user
// pastes the resulting plan/paths into Clip Studio to render.

import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import { understandVideo, downloadClipToUploads, extractSegment } from "../lib/videoUnderstand";

const SERVER_INFO = { name: "clip-studio-scout", version: "1.2.0" };
// Protocol versions we understand; we echo the client's if it's one of these, else use the latest.
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = "2025-06-18";
const PLATFORMS = ["reddit", "x", "instagram", "facebook", "youtube"] as const;

// The connector doubles as a STORY DIRECTOR: these instructions carry the whole method for
// turning scattered social clips (or one long official highlight) into one narrated "story"
// montage (Clip Studio's Match Story 2.0). The render mutes each clip's own audio and speaks ONLY
// your narration, so the narration alone must carry the story — and each clip must SHOW the exact
// moment its line describes.
const INSTRUCTIONS = [
  "ROLE: World-class football/sports short-form researcher + story director. You build ONE vertical",
  "narrated montage as a single dramatic arc (hook -> escalation -> payoff). The finished render mutes",
  "every clip's own audio and speaks ONLY your AI voiceover, so the narration IS the story and the",
  "clips play under it as muted B-roll cut to the narration.",
  "",
  "TOOLS:",
  "• list_platforms — connectivity check (which of reddit / x / instagram / facebook / youtube are usable).",
  "• search_clips — search a platform for real clips (narrow player+action+scoreline queries beat broad",
  "  ones; ONE search per beat/moment, don't combine). Pass maxAgeHours (e.g. 48) for a day-of match so",
  "  you get the just-posted threads + YouTube's newest uploads, not evergreen classics.",
  "• understand_video(url|uploadsPath, frames, startSec?, windowSec?) — WATCH a clip: keyframes +",
  "  transcript + real scene-cut timecodes. Transcript is the KEY signal. For a LONG video (a full",
  "  highlight) pass startSec/windowSec to scan just that window and get ABSOLUTE scene timecodes.",
  "• download_clip(url) — download the REAL file into the render pipeline; returns an uploads path.",
  "• extract_segment(url|uploadsPath, start, end) — cut EXACTLY [start,end] into a new uploads file",
  "  (the precise beat, e.g. the 4s a goal is scored). start/end are seconds or HH:MM:SS. On a YouTube",
  "  URL it downloads only that window; on an uploads path it trims the already-downloaded file.",
  "• get_media_result(mediaJobId) — fetch a download_clip / extract_segment result that was still",
  "  running (a full highlight can take a few minutes).",
  "",
  "GOAL: ONE tight vertical Short, 60-90 SECONDS (min 60, never over 90). Total runtime = the sum of the",
  "beat narration lines; budget ~150-220 spoken words across all beats.",
  "",
  "METHOD — follow in order:",
  "1. SET THE ANGLE. A match is not a story — pick ONE throughline (e.g. 'Mbappé's redemption', 'Morocco's",
  "   dream dies again') and make every clip serve it. If the user didn't give an angle, choose the",
  "   sharpest one.",
  "2. RESEARCH THE WHOLE STORY FIRST. Work out what ACTUALLY happened — setup, key moments IN ORDER, the",
  "   turning point, the result. Use search_clips + understand_video on SEVERAL clips (read transcripts +",
  "   frames) to gather real facts from multiple sources: names, numbers, minute marks, the score.",
  "3. FOOTAGE-GAP CHECK (do this EARLY, before writing the script). Tell the user which beats have a",
  "   verified clip and which don't. If a beat can't be filled with a clip that LITERALLY shows that",
  "   moment, STOP and show the verified-vs-missing list — do NOT pad with mismatched footage, reuse one",
  "   clip across beats, or invent URLs. If total verified runtime can't clear 60s, say so and offer:",
  "   (a) a shorter honest version now, (b) re-run in 24-48h once more clips post, or (c) fall back to the",
  "   OFFICIAL YOUTUBE HIGHLIGHT: download_clip it, then understand_video with startSec/windowSec to walk",
  "   it, and extract_segment each moment — one reliable source can supply the whole arc.",
  "4. WRITE THE NARRATION. One short storyteller line per beat — calm, specific (names + numbers),",
  "   cause->effect, light tension, most beats ending on a curiosity gap; beat 1 = the strongest hook,",
  "   final beat = the payoff, never buried. SIMPLE everyday English a 12-13 year old understands — short",
  "   punchy sentences, common words, NO rare/literary/formal vocabulary. It must stand on its own",
  "   (clips are muted); advance the story, don't just describe the screen. 4-8 beats in play order.",
  "5. VERIFY EVERY BEAT. For EACH beat, understand_video your candidate and keep it ONLY IF its keyframes",
  "   visibly show the exact action the line describes. Reject music-only / silent / low-motion / blurry /",
  "   zoomed-logo / talking-head / ambiguous clips (the transcript + motion note flag these). Use a",
  "   DIFFERENT clip per beat. Prefer Reddit clips at 720p with real commentary.",
  "",
  "TIMING TIP: run this the DAY AFTER a match, not the same night — the penalty/heartbreak clips often",
  "aren't posted for 24-48h. Same-day, lean on the official YouTube highlight + extract_segment.",
  "",
  "ERA CHECK (critical for repeat fixtures / common scorelines): a clip's title + upload date can LIE —",
  "e.g. France 2-0 Morocco happened in BOTH the 2022 semi-final AND the 2026 quarter-final, and re-upload",
  "channels slap a current-year title on old footage. Before committing ANY clip, CONFIRM its era from the",
  "TRANSCRIPT: the commentary/voiceover names the round, references 'this year', or a match-only event (a",
  "specific VAR / penalty / red-card incident). Upload date is NOT the match date — don't trust it alone.",
  "",
  "IF KEYFRAMES DON'T RENDER for you (some clients don't display tool images — start a FRESH chat if so),",
  "don't stall: LOCATE and VERIFY every moment from the TRANSCRIPT + the scene-cut timecodes — those are the",
  "reliable signal and enough to place each beat. A narrated RECAP (voiceover over footage) is fine to source",
  "since the render mutes the footage, but it may carry baked-in graphics / slow-mo — prefer a clean broadcast",
  "feed when you have the choice.",
  "",
  "OUTPUT — when the user asks you to build it, return EXACTLY this and nothing else (fields separated by",
  "' | ', one line per beat, in play order). In the first slot put a real clip URL from search_clips OR an",
  "uploads path returned by download_clip / extract_segment (both are accepted by Clip Studio):",
  "TITLE: <4-7 word title>",
  "SEGMENTS:",
  "<clip url OR uploads path> | <channel/handle> | <on-screen headline, 3-6 words> | <this beat's narration line>",
  "...",
  "",
  "Never invent a link. Keep the TOTAL narration 60-90s. Example beat line:",
  "https://www.reddit.com/r/soccer/comments/abc/ | r/soccer | Egypt Break The Deadlock | Twenty-three minutes in, Egypt catch them cold: a quick counter, one-nil, and the underdogs are suddenly dreaming.",
  "",
  "CLIP-MATCHING MODE: sometimes the user has ALREADY written the finished script and pastes their",
  "numbered beats asking ONLY for clips. Do NOT rewrite/shorten/re-order their narration — their words are",
  "final. Just find + understand_video-verify ONE real clip per beat that visibly shows it (prefer a clip",
  "AT LEAST as long as the line, ~12s+), and return one line per beat, in the SAME order, nothing else:",
  "CLIPS:",
  "1 | <clip url OR uploads path> | <on-screen headline, 3-6 words>",
  "2 | ...",
  "",
  "FOOTAGE SHARPNESS (hard gate — soft clips are REJECTED at render, not fixed): resolution alone",
  "does NOT mean sharp. AI-recap channels, 'highlights' re-uploads and news rips routinely publish a",
  "nominal 1920x1080 at a starved bitrate that renders as visible mush in the finished Short. Prefer",
  "real broadcast footage, official league/club uploads and original fan video; be suspicious of",
  "channels whose titles are auto-generated or whose clips look upscaled. understand_video reports each",
  "clip's resolution — treat anything under 720p on the short side as unusable, and judge apparent",
  "detail from the keyframes themselves rather than trusting the stated resolution.",
  "",
  "NEVER propose an intro title card. The first frame of a Short must be moving footage.",
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
      "Search Reddit, X (Twitter), Instagram, Facebook and YouTube for the best video clips about a " +
      "topic, ranked by relevance + engagement + recency + quality. Returns candidate clips with title, " +
      "platform, author, score, engagement, duration, age (when known), source URL — PLUS a real " +
      "THUMBNAIL IMAGE for the top candidates so you can pre-filter visually before spending " +
      "understand_video on each. YouTube is where the official day-of highlight lives. Read-only: it " +
      "does NOT download anything. If the search is still running when it returns, call " +
      "get_scout_results with the returned jobId for the rest.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "What to search for, e.g. 'Argentina vs Cape Verde red card'. One narrow player+action+scoreline query per beat beats a broad topic." },
        platforms: {
          type: "array",
          items: { type: "string", enum: [...PLATFORMS] },
          description: "Which platforms to search (reddit, x, instagram, facebook, youtube). Omit to search all configured platforms.",
        },
        maxCandidates: { type: "number", description: "Max clips to return (10-200, default 200 — returns everything found)." },
        maxAgeHours: { type: "number", description: "Freshness filter for a day-of match: only keep clips newer than this many hours (e.g. 48). Steers Reddit to recent threads, X to Latest, and YouTube to newest uploads. Omit for evergreen search." },
        minDurationSec: { type: "number", description: "Only keep clips at least this long, in seconds (e.g. 300 for a ≥5-min broadcast highlight instead of short reels). Clips whose title looks like a silent music montage (no commentary) are auto-demoted." },
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
      "Watch/understand a single video from a Reddit, X (Twitter), Instagram, Facebook or YouTube URL — " +
      "OR an uploads path returned by download_clip. Returns KEYFRAME IMAGES sampled at the key ACTION " +
      "moments (scene changes), a transcript of the spoken commentary, a motion note, and the real " +
      "SCENE-CUT TIMECODES (seconds) — use those as in/out anchors for extract_segment. ALWAYS " +
      "understand a clip before assigning it to a beat; the transcript is your key signal. To find a " +
      "moment inside a LONG video (e.g. a full highlight), pass startSec + windowSec to scan just that " +
      "window and get absolute scene timecodes for it, then step the window along. Usually ~50s, but a " +
      "few minutes when the render cloud is on (far more accurate medium.en transcription then).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The video URL (reddit, x/twitter, instagram, facebook, youtube) OR an uploads path from download_clip." },
        frames: { type: "number", description: "How many keyframes to return (1-8, default 6)." },
        startSec: { type: "number", description: "Optional: start of the window to analyse (seconds) — for scanning a long video. Omit to analyse the whole clip." },
        windowSec: { type: "number", description: "Optional: length of the window to analyse (seconds, default 90 when startSec is given). Keeps a long-video scan fast." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "download_clip",
    description:
      "Download the REAL video file for a URL into the Clip Studio render pipeline (the uploads dir) and " +
      "return its local path + duration/resolution/audio. This is how a verified clip actually becomes " +
      "usable footage — use the returned uploads path as a Match Story beat's source, or feed it to " +
      "understand_video / extract_segment (e.g. to walk a long highlight and cut out single moments). " +
      "A short social clip finishes inline; a full YouTube highlight runs in the background — if it's " +
      "still going, call get_media_result with the returned mediaJobId.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The video URL (reddit, x/twitter, instagram, facebook, or youtube)." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "extract_segment",
    description:
      "Cut EXACTLY [start, end] out of a source into a NEW uploads file and return its path — the precise " +
      "beat, e.g. 'the 4 seconds the penalty is missed', not the whole clip. Source can be a YouTube URL " +
      "(downloads only that window, HD), any other social URL (downloads the clip, then trims), or an " +
      "uploads path from download_clip (fast trim of the already-downloaded file — ideal for pulling " +
      "several moments out of one long highlight). A long download runs in the background — if it's still " +
      "going, call get_media_result with the returned mediaJobId.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The source: a YouTube/reddit/x/instagram/facebook URL, or an uploads path from download_clip." },
        start: { type: "string", description: "Segment start — seconds (e.g. 302.5) or HH:MM:SS (e.g. 00:05:02). Omit if using `segments`." },
        end: { type: "string", description: "Segment end — seconds or HH:MM:SS. Must be after start. Omit if using `segments`." },
        segments: {
          type: "array",
          description: "Cut MULTIPLE windows from this ONE source in a single call (e.g. 5 moments from a highlight) — much faster than 5 separate calls. Each is one beat's clip.",
          items: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } }, required: ["start", "end"], additionalProperties: false },
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "get_media_result",
    description:
      "Fetch the result of a download_clip or extract_segment call that was still running when it " +
      "returned (a full highlight download can take a few minutes). Returns the finished uploads path, or " +
      "'still working' if it isn't done yet — poll again.",
    inputSchema: {
      type: "object",
      properties: {
        mediaJobId: { type: "string", description: "The mediaJobId returned by download_clip / extract_segment." },
      },
      required: ["mediaJobId"],
      additionalProperties: false,
    },
  },
];

// Compact "how old is this clip" for the candidate list — helps judge freshness for a day-of match.
function humanAge(createdAt?: number | null): string {
  if (!createdAt || createdAt <= 0) return "";
  const s = Math.max(0, Date.now() / 1000 - createdAt);
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

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
    const age = humanAge(c.createdAt);
    const ageStr = age ? ` · ${age}` : "";
    const thumb = c.thumbUrl ? `\n   thumb: ${c.thumbUrl}` : "";
    const why = Array.isArray(c.reasons) && c.reasons.length ? `\n   why: ${c.reasons.join(", ")}` : "";
    return `${i + 1}. [${c.platform}] score ${c.score} — ${c.title || "(no title)"}\n   by ${c.author} · ${c.engagement} engagement${dur}${ageStr}\n   ${c.sourceUrl}${thumb}${why}`;
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

async function runSearchClips(args: any): Promise<ToolResult> {
  const topic = String(args?.topic ?? "").trim();
  if (topic.length < 2) throw new Error("Provide a topic to search for (at least 2 characters).");
  const platforms = Array.isArray(args?.platforms)
    ? args.platforms.filter((p: unknown): p is string => (PLATFORMS as readonly string[]).includes(p as string))
    : undefined;
  const maxCandidates = Math.min(200, Math.max(10, Number(args?.maxCandidates) || 200));
  const maxAgeHoursNum = Number(args?.maxAgeHours);
  const maxAgeHours = Number.isFinite(maxAgeHoursNum) && maxAgeHoursNum > 0 ? maxAgeHoursNum : undefined;
  const minDurNum = Number(args?.minDurationSec);
  // Clamp to a sane ceiling so a nonsense value (e.g. 99999) doesn't silently filter out everything.
  const minDurationSec = Number.isFinite(minDurNum) && minDurNum > 0 ? Math.min(3600, minDurNum) : undefined;

  const job = await apiFetch("/scout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, platforms, maxCandidates, maxAgeHours, minDurationSec }),
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
  return renderJobResult(cur);
}

async function runGetResults(args: any): Promise<ToolResult> {
  const jobId = String(args?.jobId ?? "").trim();
  if (!jobId) throw new Error("Provide the jobId returned by search_clips.");
  const job = await apiFetch(`/scout/${encodeURIComponent(jobId)}`);
  return renderJobResult(job);
}

type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface ToolResult { content: ContentBlock[]; isError?: boolean }

const textResult = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

// Fetch a candidate's remote thumbnail as an MCP image block, bounded in time + size so a slow or
// huge CDN image can never stall or bloat the tool result. Non-image / oversize / slow → null.
async function fetchThumb(url: string): Promise<ContentBlock | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal });
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") || "").split(";")[0]!.trim();
    if (!mime.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200 || buf.length > 250_000) return null; // skip broken/oversize to bound payload
    return { type: "image", data: buf.toString("base64"), mimeType: mime };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Render a scout job as the text list PLUS real thumbnail images for the top candidates, so Claude
// can pre-filter visually before spending a full understand_video on each. Thumbnails are best-effort
// (parallel, capped in count + size); the text list always carries EVERY candidate regardless.
async function renderJobResult(job: any): Promise<ToolResult> {
  const content: ContentBlock[] = [{ type: "text", text: renderJob(job) }];
  const cands: any[] = Array.isArray(job?.candidates) ? job.candidates : [];
  const top = cands.filter((c) => typeof c.thumbUrl === "string" && c.thumbUrl).slice(0, 8);
  if (top.length) {
    const imgs = await Promise.all(top.map((c) => fetchThumb(c.thumbUrl)));
    top.forEach((c, idx) => {
      const img = imgs[idx];
      if (!img) return;
      content.push({ type: "text", text: `Thumbnail — clip #${cands.indexOf(c) + 1} [${c.platform}] ${(c.title || "").slice(0, 60)}` });
      content.push(img);
    });
  }
  return { content };
}

async function runUnderstandVideo(args: any): Promise<ToolResult> {
  const url = String(args?.url ?? "").trim();
  if (!url) throw new Error("Provide a video URL (Reddit, X, Instagram, Facebook, YouTube) or an uploads path from download_clip.");
  const startNum = Number(args?.startSec);
  const windowNum = Number(args?.windowSec);
  const startSec = Number.isFinite(startNum) && startNum >= 0 ? startNum : undefined;
  const windowSec = Number.isFinite(windowNum) && windowNum > 0 ? windowNum : undefined;
  // Hard ceiling so a slow/degenerate source (a big file, a stalled transcription) can NEVER hang the
  // request forever — that showed up as a "tool execution" crash. On timeout, return an actionable error.
  const u = await Promise.race([
    understandVideo(url, Number(args?.frames) || 6, startSec, windowSec),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(
      "understand_video ran too long and was aborted (the source is likely large or the transcription stalled). Scan a SHORTER window — pass startSec + windowSec of ~10-15s over just the part you need."
    )), 130_000)),
  ]);
  const res = u.width ? ` · ${u.width}x${u.height}` : "";
  const windowed = startSec != null || windowSec != null;
  const lines = [`Video from ${u.platform} · ${Math.round(u.durationSec)}s${res}${windowed ? ` (analysed ${u.windowStart.toFixed(0)}s–${u.windowEnd.toFixed(0)}s)` : ""}.`];
  if (u.transcript) lines.push(`\nSpoken/commentary transcript${u.transcriptTruncated ? " (truncated — clip longer than the transcribed window)" : ""}:\n${u.transcript}`);
  else lines.push("\nNo speech transcript (the clip is silent or transcription was unavailable).");
  if (u.scenes.length) lines.push(`\nScene cuts (real source timecodes, seconds) — use as extract_segment in/out anchors: ${u.scenes.map((s) => s.toFixed(1)).join(", ")}`);
  if (u.notes.length) lines.push(`\nNotes: ${u.notes.join("; ")}`);
  lines.push(`\n[${u.frames.length} keyframe image(s) attached below, sampled at the clip's key action moments — read them to see exactly what happens.]`);
  const content: ContentBlock[] = [{ type: "text", text: lines.join("\n") }];
  for (const f of u.frames) content.push({ type: "image", data: f.dataBase64, mimeType: f.mimeType });
  return { content };
}

// ---------------------------------------------------------------------------
// Media jobs (download_clip / extract_segment). These WRITE a real file into the uploads dir, which
// can take minutes for a full YouTube highlight — longer than the connector's tunnel timeout. So we
// run them as in-memory background jobs (submit → poll), mirroring search_clips: the tool polls
// briefly inline, then hands back a mediaJobId for get_media_result. Evicted after 2h.
// ---------------------------------------------------------------------------

interface MediaJob { id: string; kind: "download" | "segment"; status: "running" | "done" | "error"; text?: string; error?: string; createdAt: number }
const mediaJobs = new Map<string, MediaJob>();

function startMediaJob(kind: MediaJob["kind"], work: () => Promise<string>): MediaJob {
  const id = `media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job: MediaJob = { id, kind, status: "running", createdAt: Date.now() };
  mediaJobs.set(id, job);
  void work()
    .then((text) => { job.status = "done"; job.text = text; })
    .catch((e) => { job.status = "error"; job.error = e instanceof Error ? e.message : String(e); });
  for (const [k, v] of mediaJobs) if (Date.now() - v.createdAt > 2 * 3600_000) mediaJobs.delete(k);
  return job;
}

async function pollMediaJob(job: MediaJob, budgetMs: number): Promise<ToolResult> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && job.status === "running") await sleep(1500);
  if (job.status === "done") return textResult(job.text!);
  if (job.status === "error") return { content: [{ type: "text", text: `Error: ${job.error}` }], isError: true };
  return textResult(`Still working on the ${job.kind} (a full highlight can take a few minutes). Call get_media_result with mediaJobId "${job.id}" to fetch the file path when it's done.`);
}

async function runDownloadClip(args: any): Promise<ToolResult> {
  const url = String(args?.url ?? "").trim();
  if (!url) throw new Error("Provide a video URL (Reddit, X, Instagram, Facebook or YouTube).");
  const job = startMediaJob("download", async () => {
    const r = await downloadClipToUploads(url);
    const res = r.width ? ` · ${r.width}x${r.height}` : "";
    return [
      `Downloaded ✓`,
      `path: ${r.path}`,
      `${r.platform} · ${Math.round(r.durationSec)}s${res} · ${r.hasAudio ? "has audio" : "silent"}`,
      ``,
      `Use this uploads path as a Match Story beat's source, or pass it to understand_video / extract_segment (e.g. to walk a long highlight and cut out single moments).`,
    ].join("\n");
  });
  logger.info({ url: url.slice(0, 80), jobId: job.id }, "MCP download_clip");
  return pollMediaJob(job, 35_000);
}

async function runExtractSegment(args: any): Promise<ToolResult> {
  const url = String(args?.url ?? "").trim();
  if (!url) throw new Error("Provide a source URL (YouTube/Reddit/X/IG/FB) or an uploads path from download_clip.");
  // Batch: `segments:[{start,end},…]` cuts several windows from ONE source in a single call.
  const pairs: { start: any; end: any }[] = Array.isArray(args?.segments) && args.segments.length
    ? args.segments.map((s: any) => ({ start: s?.start, end: s?.end }))
    : [{ start: args?.start, end: args?.end }];
  for (const p of pairs) if (p.start == null || p.end == null) throw new Error("Each segment needs start and end (seconds or HH:MM:SS).");
  const job = startMediaJob("segment", async () => {
    const outs: string[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const r = await extractSegment(url, pairs[i]!.start, pairs[i]!.end);
      // Warn when the source ran out before the requested end (silent ffmpeg clamp) — a blind cut would
      // otherwise ship a near-empty beat unnoticed.
      const short = r.durationSec < r.requestedSec - 0.5
        ? `  ⚠ CLAMPED — you asked for ${r.requestedSec.toFixed(1)}s but only ${r.durationSec.toFixed(1)}s of footage exists from that start (end is past the clip). Pick an earlier window.`
        : "";
      outs.push(`${pairs.length > 1 ? `[beat ${i + 1}] ` : ""}${r.path}  (${r.durationSec.toFixed(1)}s)${short}`);
    }
    return [`Segment${pairs.length > 1 ? "s" : ""} cut ✓ — pass each uploads path as a Match Story beat's source:`, ...outs].join("\n");
  });
  logger.info({ src: url.slice(0, 80), pairs: pairs.length, jobId: job.id }, "MCP extract_segment");
  return pollMediaJob(job, pairs.length > 2 ? 70_000 : 35_000);
}

async function runGetMediaResult(args: any): Promise<ToolResult> {
  const id = String(args?.mediaJobId ?? "").trim();
  if (!id) throw new Error("Provide the mediaJobId returned by download_clip / extract_segment.");
  const job = mediaJobs.get(id);
  if (!job) throw new Error("That media job wasn't found (it may have expired after 2h). Re-run download_clip / extract_segment.");
  return pollMediaJob(job, 20_000);
}

async function callTool(name: string, args: any): Promise<ToolResult> {
  switch (name) {
    case "list_platforms": return textResult(await runListPlatforms());
    case "search_clips": return runSearchClips(args);
    case "get_scout_results": return runGetResults(args);
    case "understand_video": return runUnderstandVideo(args);
    case "download_clip": return runDownloadClip(args);
    case "extract_segment": return runExtractSegment(args);
    case "get_media_result": return runGetMediaResult(args);
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
