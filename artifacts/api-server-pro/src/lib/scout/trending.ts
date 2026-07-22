// Scout — "what's trending right now" for the news operator.
//
// SAFETY: this deliberately does NOT read the user's logged-in X account (their following graph
// or the private trends API). Driving X's internal API with the user's auth_token/ct0 to harvest
// "everything with no limits" is exactly what gets a real account rate-limited then SUSPENDED, and
// it violates X's ToS. Instead we read PUBLIC trend mirrors — Google Trends' public RSS and
// trends24.in — which need no login and carry zero account risk. The operator sees the pulse of
// what's happening; picking a trend then runs the normal (public, gallery-dl) X + multi-platform
// search to find clips.

import { logger } from "../logger";

export interface Trend {
  topic: string;
  source: "google" | "x";
  url?: string; // a search/permalink to eyeball the trend
}

async function fetchText(url: string, timeoutMs = 12_000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: ctrl.signal,
    });
    return r.ok ? await r.text() : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}

// Google Trends' public "Daily Search Trends" RSS — cleanest signal of what a country is searching
// (news, sport, markets). geo=IN for India. The FIRST <title> is the feed name, so it's skipped.
async function googleTrends(geo = "IN"): Promise<Trend[]> {
  const xml = await fetchText(`https://trends.google.com/trending/rss?geo=${geo}`);
  if (!xml) return [];
  const titles = [...xml.matchAll(/<title>([\s\S]*?)<\/title>/g)].map((m) => decodeEntities(m[1]!));
  return titles.slice(1).filter(Boolean).map((topic) => ({
    topic,
    source: "google" as const,
    url: `https://x.com/search?q=${encodeURIComponent(topic)}`,
  }));
}

// trends24.in — public mirror of X's trending topics by country (no login). The markup is
// `...class=trend-link>#Something<...` (quotes on the class attr are optional in the served HTML).
async function xTrends(): Promise<Trend[]> {
  const html = await fetchText("https://trends24.in/india/");
  if (!html) return [];
  const out: Trend[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/class=["']?trend-link["']?[^>]*>([^<]+)</g)) {
    const topic = decodeEntities(m[1]!);
    if (!topic || seen.has(topic.toLowerCase())) continue;
    seen.add(topic.toLowerCase());
    out.push({ topic, source: "x", url: `https://x.com/search?q=${encodeURIComponent(topic)}` });
    if (out.length >= 30) break;
  }
  return out;
}

/**
 * Live trending topics from PUBLIC sources (no X login). Google Trends first (cleaner news
 * signal), then X trends, deduped. Never throws — a dead source just contributes nothing.
 */
export async function fetchTrending(): Promise<{ google: Trend[]; x: Trend[]; all: Trend[] }> {
  const [g, x] = await Promise.all([
    googleTrends().catch(() => [] as Trend[]),
    xTrends().catch(() => [] as Trend[]),
  ]);
  const seen = new Set<string>();
  const all: Trend[] = [];
  for (const t of [...g, ...x]) {
    const k = t.topic.toLowerCase().replace(/^#/, "");
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(t);
  }
  logger.info({ google: g.length, x: x.length, total: all.length }, "Scout trending fetched (public sources)");
  return { google: g, x, all };
}
