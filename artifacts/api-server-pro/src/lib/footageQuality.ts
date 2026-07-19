// Footage sharpness gate — the single source of truth for "is this clip good enough to
// composite into a Short". Zero project deps (node builtins only) so it can be imported by
// BOTH lib/scout (which sources clips) and lib/clipProcessor (which renders them) without a
// circular import, and so the pure judgement half is unit-testable standalone.

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Resolution floor, measured on the SHORT side (min(width,height)) because a beat can be
 * landscape or vertical: a 720x816 phone clip is genuinely sharp, while 640x360 is mush once
 * scaled into the 1080-wide frame.
 */
export const MIN_BEAT_SHORT_SIDE = 720;

/**
 * Detail floor in bits-per-pixel-per-frame. This is the gate that catches "fake HD" —
 * upscaled / heavily re-encoded re-uploads that report 1920x1080 but carry no detail.
 * Resolution alone cannot see this. Measured on the beats of the first Mbappé render:
 *
 *     AI-recap re-upload   1920x1080 @  519 kbps  -> 0.008   (visibly mush — this one shipped)
 *     news broadcast rip   1920x1080 @  868 kbps  -> 0.017   (soft)
 *     720p highlight reel  1280x720  @  878 kbps  -> 0.032   (fine)
 *     real broadcast 1080p 1920x1080 @ 2733 kbps  -> 0.044   (sharp)
 *
 * 0.02 sits in the gap between the soft and the sharp. Deliberately conservative: efficient
 * codecs (AV1/HEVC) hold up below this on LOW-motion video, but football is high-motion,
 * which is exactly where a starved bitrate falls apart.
 */
export const MIN_BEAT_BITS_PER_PIXEL = 0.02;

export type FootageStats = {
  duration: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  bitsPerPixel?: number;
};

export type QualityOpts = { minShortSide?: number; minBitsPerPixel?: number };

/** Parse ffprobe's "30000/1001" style rational into fps. */
function parseFps(r: string | undefined): number {
  if (!r) return 0;
  const [n, d] = r.split("/").map(Number);
  if (!n || !d) return Number(r) || 0;
  return n / d;
}

/** ffprobe a file into the stats the gate needs. Never throws — a failed probe returns zeros. */
export async function probeFootage(file: string): Promise<FootageStats> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration,bit_rate:stream=codec_type,width,height,bit_rate,avg_frame_rate",
      "-of", "json", file,
    ], { timeout: 30_000 });
    const j = JSON.parse(stdout) as {
      format?: { duration?: string; bit_rate?: string };
      streams?: { codec_type: string; width?: number; height?: number; bit_rate?: string; avg_frame_rate?: string }[];
    };
    const v = (j.streams ?? []).find((s) => s.codec_type === "video");
    const hasAudio = (j.streams ?? []).some((s) => s.codec_type === "audio");
    const vBitrate = Number(v?.bit_rate) || Number(j.format?.bit_rate) || 0;
    const fps = parseFps(v?.avg_frame_rate);
    const bitsPerPixel = v?.width && v?.height && vBitrate && fps
      ? vBitrate / (v.width * v.height * fps)
      : undefined;
    return { duration: parseFloat(j.format?.duration ?? "0") || 0, width: v?.width, height: v?.height, hasAudio, bitsPerPixel };
  } catch {
    return { duration: 0, hasAudio: false };
  }
}

/**
 * Judge already-probed stats. PURE — no I/O, so the thresholds are unit-testable.
 *
 * Unknown values PASS. A failed probe is not evidence of low quality, and the same
 * "unknown is not a reason to drop" stance is taken by the duration and recency filters.
 * Pass 0 for either floor to disable it.
 */
export function judgeFootage(stats: FootageStats, opts: QualityOpts = {}): { ok: true } | { ok: false; reason: string } {
  const minShort = opts.minShortSide ?? MIN_BEAT_SHORT_SIDE;
  const minBpp = opts.minBitsPerPixel ?? MIN_BEAT_BITS_PER_PIXEL;

  const shortSide = stats.width && stats.height ? Math.min(stats.width, stats.height) : null;
  if (minShort > 0 && shortSide != null && shortSide < minShort) {
    return { ok: false, reason: `too small — ${stats.width}x${stats.height} (short side ${shortSide}px, floor ${minShort}px)` };
  }
  if (minBpp > 0 && stats.bitsPerPixel != null && stats.bitsPerPixel < minBpp) {
    return {
      ok: false,
      reason: `too soft — ${stats.width}x${stats.height} but only ${stats.bitsPerPixel.toFixed(4)} bits/pixel `
        + `(floor ${minBpp}); upscaled or heavily re-encoded re-upload`,
    };
  }
  return { ok: true };
}
