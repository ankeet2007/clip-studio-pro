// Scout stage 2.5 — PRE-DOWNLOAD measurement.
//
// The ranker used to score four proxies for popularity and freshness and zero measurements of
// the actual artifact: relevance read the title, engagement read the crowd, recency read the
// clock, and "quality" read the DURATION. Nothing read the video. That is why a 1920x1080
// re-upload at 519kbps (0.008 bits/pixel, visibly mush) ranked identically to real broadcast
// 1080p at 2733kbps (0.044 bpp) — the one axis on which they differ was never looked at.
//
// yt-dlp can report a clip's real dimensions, framerate, bitrate and uploader WITHOUT
// downloading it, so the sharpness signal can be a RANKING input rather than a post-hoc
// rejection. Verified against a real URL: the pre-download bits-per-pixel matched the
// post-download ffprobe measurement of the same file to 3 decimal places.
//
// Split: everything above `probeCandidate` is PURE and unit-tested; only the exec wrapper
// touches the network.

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * ⚠️ fps is LOAD-BEARING — do not drop it from this format string.
 *
 * bits-per-pixel = vbr / (width * height * fps). Sports broadcast feeds are very often 50 or
 * 60 fps; assuming 30 on a 60fps clip DOUBLES the computed bpp, which would let genuine mush
 * through the gate while demoting the sharpest footage available. If fps is unknown we return
 * `undefined` and score neutral — we never guess it.
 *
 * `upload_date` is a free rider: the YouTube adapter can't get a real timestamp from a flat
 * search (it sets createdAt: 0), so the existing maxAgeHours filter silently does nothing on
 * YouTube. This repairs that at zero extra cost.
 */
export const PROBE_PRINT_FORMAT =
  "%(width)s|%(height)s|%(fps)s|%(tbr)s|%(vbr)s|%(uploader)s|%(channel)s|%(upload_date)s";

export interface ProbeResult {
  width?: number;
  height?: number;
  fps?: number;
  /** bits per pixel per frame; undefined when any input was missing. */
  bitsPerPixel?: number;
  /** True when bpp was derived from tbr (includes audio, so it overstates by ~5-10%). */
  bppApprox?: boolean;
  uploader?: string;
  /** unix seconds parsed from upload_date (YYYYMMDD), 0 when absent. */
  uploadedAt: number;
}

/** yt-dlp prints the literal string "NA" for absent fields. */
function num(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (!t || t === "NA" || t === "none" || t === "null") return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function str(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  return !t || t === "NA" || t === "none" ? undefined : t;
}

/** "20260704" -> unix seconds. Returns 0 on anything unparseable. */
export function parseUploadDate(v: string | undefined): number {
  const t = str(v);
  if (!t || !/^\d{8}$/.test(t)) return 0;
  const y = Number(t.slice(0, 4)), m = Number(t.slice(4, 6)), d = Number(t.slice(6, 8));
  const ms = Date.UTC(y, m - 1, d);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * bits per pixel per frame. Prefers the VIDEO bitrate; falls back to the TOTAL bitrate
 * (which includes audio and therefore overstates — the caller compensates via `bppApprox`).
 * Any missing input ⇒ undefined. NEVER substitutes a default fps.
 */
export function bitsPerPixel(
  width?: number, height?: number, fps?: number, vbrKbps?: number, tbrKbps?: number,
): { bpp?: number; approx: boolean } {
  const rate = vbrKbps ?? tbrKbps;
  if (!width || !height || !fps || !rate) return { bpp: undefined, approx: false };
  return { bpp: (rate * 1000) / (width * height * fps), approx: vbrKbps == null };
}

/** Parse one `yt-dlp --print PROBE_PRINT_FORMAT` line. PURE. */
export function parseProbeLine(stdout: string): ProbeResult {
  const line = (stdout || "").trim().split("\n").filter(Boolean).pop() ?? "";
  const f = line.split("|");
  const width = num(f[0]), height = num(f[1]), fps = num(f[2]);
  const tbr = num(f[3]), vbr = num(f[4]);
  const { bpp, approx } = bitsPerPixel(width, height, fps, vbr, tbr);
  return {
    width, height, fps,
    bitsPerPixel: bpp,
    bppApprox: bpp == null ? undefined : approx,
    uploader: str(f[5]) ?? str(f[6]),
    uploadedAt: parseUploadDate(f[7]),
  };
}

// ---- I/O below this line ----

/**
 * MEASURED on the phone, not guessed: a single metadata probe takes 13-32s (yt-dlp still does
 * a full extractor round-trip even with --no-download). An earlier 6s timeout here would have
 * failed EVERY probe silently — every candidate would have scored neutral sharpness and the
 * whole measurement pass would have been a no-op that looked like it was working. 45s covers
 * the observed worst case with headroom.
 */
export const PROBE_TIMEOUT_MS = 45_000;

/** 6h cache: probing is the slow part and a candidate can appear across several searches. */
const cache = new Map<string, { at: number; result: ProbeResult }>();
const CACHE_TTL_MS = 6 * 3600_000;

/**
 * ffprobe a STREAM url (HLS manifest or direct media) without downloading it.
 *
 * This exists because yt-dlp's metadata is not enough on the platforms that now matter most:
 *   • X returns NO fps at all — null at top level AND per-format — so bpp comes out undefined.
 *   • Reddit cannot be probed by yt-dlp from this IP at all ("unable to access the Reddit API").
 * ffprobe reads the manifest directly and reports width/height/fps/bitrate. Measured on a real
 * X clip it returned 60fps where yt-dlp said NA — and assuming 30 there would have DOUBLED the
 * computed bpp, scoring fan-shot phone footage as premium broadcast.
 */
async function ffprobeStream(streamUrl: string): Promise<Partial<ProbeResult> | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,avg_frame_rate,bit_rate",
      "-of", "json", streamUrl,
    ], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    const st = (JSON.parse(stdout)?.streams ?? [])[0];
    if (!st) return null;
    const width = Number(st.width) || undefined;
    const height = Number(st.height) || undefined;
    const [fn, fd] = String(st.avg_frame_rate ?? "").split("/").map(Number);
    const fps = fn && fd ? fn / fd : undefined;
    const bitrateKbps = Number(st.bit_rate) ? Number(st.bit_rate) / 1000 : undefined;
    const { bpp, approx } = bitsPerPixel(width, height, fps, bitrateKbps);
    return { width, height, fps, bitsPerPixel: bpp, bppApprox: bpp == null ? undefined : approx };
  } catch {
    return null;
  }
}

/** Resolve a page url to its direct media/manifest url (no download). */
async function resolveStreamUrl(url: string, cookieFile: string | undefined, ytDlpPath: string): Promise<string | null> {
  try {
    const args = ["--no-download", "--no-warnings", "-g"];
    if (cookieFile) args.push("--cookies", cookieFile);
    args.push(url);
    const { stdout } = await execFileAsync(ytDlpPath, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    const first = stdout.split("\n").map((l) => l.trim()).filter(Boolean)[0];
    return first && /^https?:\/\//.test(first) ? first : null;
  } catch {
    return null;
  }
}

export interface ProbeOpts {
  cookieFile?: string;
  ytDlpPath?: string;
  /** A direct media/HLS url the adapter already resolved (Reddit's v.redd.it), which lets us
   *  skip yt-dlp entirely on platforms where it cannot reach the site's API. */
  directUrl?: string;
}

export async function probeCandidate(url: string, optsOrCookie?: ProbeOpts | string, legacyYtDlp = "yt-dlp"): Promise<ProbeResult | null> {
  const opts: ProbeOpts = typeof optsOrCookie === "string" || optsOrCookie == null
    ? { cookieFile: optsOrCookie as string | undefined, ytDlpPath: legacyYtDlp }
    : optsOrCookie;
  const ytDlpPath = opts.ytDlpPath ?? "yt-dlp";

  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  const finish = (r: ProbeResult): ProbeResult => {
    cache.set(url, { at: Date.now(), result: r });
    for (const [k, v] of cache) if (Date.now() - v.at > CACHE_TTL_MS) cache.delete(k);
    return r;
  };

  // Fast path when the adapter already has a direct stream url (Reddit).
  if (opts.directUrl) {
    const ff = await ffprobeStream(opts.directUrl);
    if (ff) return finish({ ...ff, uploadedAt: 0 } as ProbeResult);
  }

  let base: ProbeResult | null = null;
  try {
    const args = ["--no-download", "--no-warnings", "--no-playlist", "--print", PROBE_PRINT_FORMAT];
    if (opts.cookieFile) args.push("--cookies", opts.cookieFile);
    args.push(url);
    const { stdout } = await execFileAsync(ytDlpPath, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    base = parseProbeLine(stdout);
  } catch {
    // Timeouts, throttling, geo-blocks, dead links. Not evidence of low quality — fall through
    // and try to measure the stream itself before giving up.
    base = null;
  }

  // yt-dlp gave us a usable measurement (YouTube's normal path).
  if (base?.bitsPerPixel != null) return finish(base);

  // Otherwise measure the actual stream. This is the X case (no fps) and the Reddit case
  // (no API access) — i.e. exactly the platforms that are now primary.
  const stream = await resolveStreamUrl(url, opts.cookieFile, ytDlpPath);
  if (stream) {
    const ff = await ffprobeStream(stream);
    if (ff) return finish({ ...(base ?? { uploadedAt: 0 }), ...ff } as ProbeResult);
  }
  return base ? finish(base) : null;
}

/**
 * Probe many URLs with bounded concurrency.
 *
 * Capped at 4: each yt-dlp process is ~40MB RSS and the phone is armv7 with little RAM, so a
 * wider fan-out OOMs the box (the same failure class that has repeatedly killed sshd here).
 * Also keeps request pressure low enough to avoid tripping YouTube throttling from one IP.
 *
 * Throughput at the MEASURED 13-32s per probe: ~24 candidates ≈ 2 minutes. That is why this
 * runs inside the background scout job and never on the request path.
 */
export async function probeAll(
  urls: { url: string; cookieFile?: string; directUrl?: string }[],
  ytDlpPath = "yt-dlp",
  concurrency = 4,
): Promise<Map<string, ProbeResult>> {
  const out = new Map<string, ProbeResult>();
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (i < urls.length) {
      const item = urls[i++]!;
      const r = await probeCandidate(item.url, { cookieFile: item.cookieFile, ytDlpPath, directUrl: item.directUrl });
      if (r) out.set(item.url, r);
    }
  });
  await Promise.all(workers);
  return out;
}
