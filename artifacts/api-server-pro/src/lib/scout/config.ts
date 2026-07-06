// Scout credentials/cookies, read from the same on-disk settings file the app already uses
// (~/myapp/clips_settings.json). Never committed. All fields optional — an adapter that lacks
// its creds reports isConfigured()=false and is simply skipped.

import fs from "fs";
import os from "os";
import path from "path";

const SETTINGS_FILE = path.join(os.homedir(), "myapp", "clips_settings.json");

export interface ScoutConfig {
  reddit?: { clientId?: string; clientSecret?: string };
  // Later phases: cookie files for the fragile platforms.
  cookies?: { x?: string; instagram?: string; facebook?: string };
}

export function readScoutConfig(): ScoutConfig {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as { scout?: ScoutConfig };
      return raw.scout ?? {};
    }
  } catch { /* fall through */ }
  return {};
}

// The user drops per-platform Netscape cookies.txt files here (auto-detected). One file per
// platform does double duty: yt-dlp download (--cookies) AND the authenticated search fetch.
export const COOKIE_DIR = path.join(os.homedir(), "myapp", "scout_cookies");

/** Absolute path to a platform's cookies.txt if present (dir convention or explicit config). */
export function cookieFileFor(platform: string): string | undefined {
  const p = path.join(COOKIE_DIR, `${platform}.txt`);
  if (fs.existsSync(p)) return p;
  const fromCfg = (readScoutConfig().cookies as Record<string, string> | undefined)?.[platform];
  return fromCfg && fs.existsSync(fromCfg) ? fromCfg : undefined;
}

/** Build a `Cookie:` header from a platform's cookies.txt (for non-yt-dlp fetches like search). */
export function cookieHeaderFor(platform: string, domainMatch: RegExp): string | undefined {
  const file = cookieFileFor(platform);
  if (!file) return undefined;
  try {
    const pairs: string[] = [];
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split("\t");
      if (parts.length < 7) continue;
      if (!domainMatch.test(parts[0]!)) continue;
      pairs.push(`${parts[5]}=${parts[6]}`);
    }
    return pairs.length ? pairs.join("; ") : undefined;
  } catch {
    return undefined;
  }
}
