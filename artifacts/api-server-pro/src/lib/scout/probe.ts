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

export async function probeCandidate(url: string, cookieFile?: string, ytDlpPath = "yt-dlp"): Promise<ProbeResult | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  const args = ["--no-download", "--no-warnings", "--no-playlist", "--print", PROBE_PRINT_FORMAT];
  if (cookieFile) args.push("--cookies", cookieFile);
  args.push(url);
  try {
    const { stdout } = await execFileAsync(ytDlpPath, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    const result = parseProbeLine(stdout);
    cache.set(url, { at: Date.now(), result });
    for (const [k, v] of cache) if (Date.now() - v.at > CACHE_TTL_MS) cache.delete(k);
    return result;
  } catch {
    // Timeouts, throttling, geo-blocks, dead links. A failed probe is NOT evidence of low
    // quality — the caller scores it neutral rather than dropping it.
    return null;
  }
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
  urls: { url: string; cookieFile?: string }[],
  ytDlpPath = "yt-dlp",
  concurrency = 4,
): Promise<Map<string, ProbeResult>> {
  const out = new Map<string, ProbeResult>();
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (i < urls.length) {
      const item = urls[i++]!;
      const r = await probeCandidate(item.url, item.cookieFile, ytDlpPath);
      if (r) out.set(item.url, r);
    }
  });
  await Promise.all(workers);
  return out;
}
