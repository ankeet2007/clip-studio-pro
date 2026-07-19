// Verification receipts — turning "the model should check the footage" into "the server will
// not render a beat nobody looked at".
//
// WHY THIS EXISTS. The connector INSTRUCTIONS have said "verify every beat" for a long time.
// It is prose, and prose is ignorable — the observed failures are what ignoring it looks like:
// a cat meme that matched a title, and a clip whose on-screen chyron read
// "ARGENTINA 1-2 IN THE SEMIFINAL" playing under a narration line about France. Neither is
// detectable from metadata, from bitrate, or from a transcript. Both are plainly VISIBLE.
//
// So verification becomes a PRECONDITION: verify_moment records a receipt describing what was
// actually seen in a specific time window of a specific asset, and create_match_story refuses
// a beat that has no matching receipt. A request the model may skip becomes a check it cannot.
//
// This module is PURE (no I/O) apart from the in-memory store, so the matching rules — which
// are the security-relevant part — are unit-testable.

export type Verdict = "confirmed" | "rejected" | "unverified";

export interface Receipt {
  verifyId: string;
  /** Normalised asset key — an uploads path or a source URL. */
  asset: string;
  windowStart: number;
  windowEnd: number;
  verdict: Verdict;
  /** Text read off the frames. The chyron check runs against this. */
  onScreenText: string[];
  /** What the verifier said the footage depicts. */
  depicts: string;
  /** Flags for footage that is technically right but unusable. */
  flags: string[];
  backend: "gemini" | "connector" | "derived";
  ts: number;
}

/** Receipts expire with the same 2h TTL as the scout/media job maps. A restart clears them;
 *  the caller is told to re-verify rather than silently rendering something unchecked. */
export const RECEIPT_TTL_MS = 2 * 3600_000;

const receipts = new Map<string, Receipt>();

/** Normalise an asset reference so a receipt minted for `/uploads/x.mp4` matches a beat that
 *  names the same file by absolute path, and URLs compare without trailing noise. */
export function normalizeAsset(a: string): string {
  const s = String(a ?? "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  return s.split("/").pop()!.toLowerCase();   // compare local files by basename
}

export function putReceipt(r: Omit<Receipt, "verifyId" | "ts"> & { verifyId?: string }): Receipt {
  const verifyId = r.verifyId ?? `vf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const rec: Receipt = { ...r, verifyId, asset: normalizeAsset(r.asset), ts: Date.now() };
  receipts.set(verifyId, rec);
  for (const [k, v] of receipts) if (Date.now() - v.ts > RECEIPT_TTL_MS) receipts.delete(k);
  return rec;
}

export function getReceipt(verifyId: string): Receipt | undefined {
  const r = receipts.get(verifyId);
  if (!r) return undefined;
  if (Date.now() - r.ts > RECEIPT_TTL_MS) { receipts.delete(verifyId); return undefined; }
  return r;
}

export interface BeatRef {
  asset: string;
  start: number;
  end: number;
}

export type MatchResult = { ok: true } | { ok: false; reason: string };

/**
 * Does this receipt actually cover this beat? PURE — this is the enforcement rule.
 *
 * A receipt is only meaningful if it describes the SAME asset and a window that OVERLAPS what
 * will be rendered. Without the overlap check a caller could verify the first 3 seconds of a
 * highlight and then render minute 8 of it, which is precisely the "technically verified,
 * actually wrong" hole this whole mechanism exists to close.
 */
export function matchesReceipt(receipt: Receipt | undefined, beat: BeatRef, now = Date.now()): MatchResult {
  if (!receipt) return { ok: false, reason: "no receipt — call verify_moment for this beat first" };
  if (now - receipt.ts > RECEIPT_TTL_MS) return { ok: false, reason: "receipt expired — re-verify this beat" };
  if (receipt.verdict === "rejected") {
    return { ok: false, reason: `verifier rejected this footage: ${receipt.depicts || "does not depict the described moment"}` };
  }
  if (normalizeAsset(beat.asset) !== receipt.asset) {
    return { ok: false, reason: `receipt is for a different clip (${receipt.asset})` };
  }
  // Overlap, not containment: a 3-frame sample legitimately covers a window narrower than the
  // rendered beat, so requiring full containment would reject honest verifications.
  const overlaps = beat.start < receipt.windowEnd && beat.end > receipt.windowStart;
  if (!overlaps) {
    return {
      ok: false,
      reason: `receipt covers ${receipt.windowStart.toFixed(1)}-${receipt.windowEnd.toFixed(1)}s but the beat uses ${beat.start.toFixed(1)}-${beat.end.toFixed(1)}s — verify the part you will actually render`,
    };
  }
  return { ok: true };
}

/**
 * Does the text burned into the frames contradict what the narration claims?
 *
 * The concrete failure: a clip captioned with a France narration line while an
 * "ARGENTINA 1-2 IN THE SEMIFINAL" chyron sat on screen. Broadcast graphics naming a team or
 * scoreline that the line never mentions are strong evidence the clip is from a different
 * match. PURE.
 */
export function contradictsNarration(onScreenText: string[], narration: string, knownEntities: string[]): string | null {
  const said = ` ${narration.toLowerCase()} `;
  const screen = onScreenText.join(" ").toLowerCase();
  for (const e of knownEntities) {
    const k = e.toLowerCase();
    if (k.length < 4) continue;
    // On screen but never spoken in this beat's line, and not a generic competition tag.
    if (screen.includes(k) && !said.includes(k)) return `on-screen text names "${e}" but the narration line never mentions it`;
  }
  return null;
}
