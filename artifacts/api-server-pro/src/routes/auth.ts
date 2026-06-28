import { Router, type Request, type Response } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { eq } from "drizzle-orm";
import { db, appConfigTable } from "@workspace/db-pro";
import { logger } from "../lib/logger";

const router = Router();

// Same credentials as the yt-dlp-youtube-oauth2 plugin (YouTube TV client)
const CLIENT_ID = "861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com";
const CLIENT_SECRET = "SboVhoG9s0rNafixCSGGKXAT";
const SCOPES = "https://gdata.youtube.com https://www.googleapis.com/auth/youtube";

// yt-dlp plugin stores the token here using its cache format: {"yt-dlp_version": "...", "data": {...}}
const TOKEN_DIR = path.join(os.homedir(), ".cache", "yt-dlp", "youtube-oauth2");
const TOKEN_PATH = path.join(TOKEN_DIR, "token_data.json");
const YTDLP_VERSION = "2026.06.09"; // must match installed yt-dlp version

interface TokenData {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires: number;
}

interface AuthState {
  status: "idle" | "pending" | "done" | "error";
  userCode: string;
  verificationUrl: string;
  deviceCode: string;
  interval: number;
  pollTimer: ReturnType<typeof setInterval> | null;
}

let authState: AuthState = {
  status: "idle",
  userCode: "",
  verificationUrl: "",
  deviceCode: "",
  interval: 5,
  pollTimer: null,
};

export function isOAuthTokenCached(): boolean {
  if (!fs.existsSync(TOKEN_PATH)) return false;
  try {
    const file = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8")) as { data?: TokenData } | TokenData;
    // Support both yt-dlp cache format {"yt-dlp_version":…,"data":{…}} and legacy raw format
    const token = ("data" in file && file.data) ? file.data : file as TokenData;
    return !!(token.access_token && token.refresh_token);
  } catch {
    return false;
  }
}

export function getOAuthArgs(): string[] {
  // The yt-dlp-youtube-oauth2 plugin activates automatically from its cache.
  // Passing --username oauth2 forces a new auth flow and IGNORES the cached token — don't do it.
  return [];
}

async function saveToken(token: TokenData): Promise<void> {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  // Must match yt-dlp's cache format so the plugin can read it via self.cache.load()
  const cachePayload = { "yt-dlp_version": YTDLP_VERSION, data: token };
  const json = JSON.stringify(cachePayload);
  fs.writeFileSync(TOKEN_PATH, json, { mode: 0o600 });
  logger.info("YouTube OAuth2 token saved to disk");

  // Persist to DB so the token survives server restarts and redeployments.
  // Awaited so the token is durably stored before we return to the caller.
  try {
    await db.insert(appConfigTable)
      .values({ key: "youtube_oauth_token", value: json })
      .onConflictDoUpdate({ target: appConfigTable.key, set: { value: json } })
      .execute();
  } catch (err: unknown) {
    logger.error({ err }, "Failed to persist OAuth token to DB");
  }
}

/**
 * Called on server startup. Restores the OAuth2 token from the DB to the
 * yt-dlp cache file so the plugin can authenticate without re-running the flow.
 */
export async function restoreTokenFromDB(): Promise<void> {
  try {
    const [row] = await db
      .select()
      .from(appConfigTable)
      .where(eq(appConfigTable.key, "youtube_oauth_token"));

    if (!row) {
      logger.info("No OAuth2 token in DB — user needs to connect via Settings");
      return;
    }

    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_PATH, row.value, { mode: 0o600 });
    logger.info("YouTube OAuth2 token restored from DB");
  } catch (err) {
    logger.error({ err }, "Failed to restore OAuth2 token from DB");
  }
}

function stopPolling(): void {
  if (authState.pollTimer) {
    clearInterval(authState.pollTimer);
    authState.pollTimer = null;
  }
}

async function pollForToken(): Promise<void> {
  try {
    // Google requires form-encoded body and the key is "device_code" (not "code")
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      device_code: authState.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const data = await res.json() as Record<string, unknown>;
    const error = data["error"];

    if (error === "authorization_pending" || error === "slow_down") return; // User hasn't entered code yet

    if (error === "expired_token") {
      logger.warn("Device code expired — user needs to restart auth");
      stopPolling();
      authState.status = "error";
      return;
    }

    if (error) {
      // Only truly transient network hiccups should be retried silently.
      // Persistent errors (invalid_client, invalid_grant, access_denied, …) will
      // never resolve on their own — stop polling so the UI can surface them.
      const transient = error === "temporarily_unavailable";
      if (transient) {
        logger.warn({ error }, "OAuth2 poll transient error — retrying");
        return;
      }
      logger.error({ error }, "OAuth2 poll fatal error — stopping");
      stopPolling();
      authState.status = "error";
      return;
    }

    // Success — save token in yt-dlp plugin format
    await saveToken({
      access_token: data["access_token"] as string,
      refresh_token: data["refresh_token"] as string,
      token_type: data["token_type"] as string,
      expires: Date.now() / 1000 + (data["expires_in"] as number),
    });

    stopPolling();
    authState.status = "done";
  } catch (err) {
    logger.warn({ err }, "OAuth2 poll request failed");
  }
}

function startPolling(): void {
  stopPolling();
  authState.pollTimer = setInterval(() => {
    pollForToken().catch((err) => logger.warn({ err }, "Poll error"));
  }, authState.interval * 1000);
}

// POST /api/auth/youtube/start
router.post("/start", async (_req: Request, res: Response) => {
  // Already connected
  if (isOAuthTokenCached()) {
    authState.status = "done";
    return res.json({ status: "done" });
  }

  // Already pending with a code — return it so user can try again on a new browser tab
  if (authState.status === "pending" && authState.userCode) {
    return res.json({
      status: "pending",
      userCode: authState.userCode,
      verificationUrl: authState.verificationUrl,
    });
  }

  // Request a new device code from Google
  try {
    const codeRes = await fetch("https://www.youtube.com/o/oauth2/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        scope: SCOPES,
        device_id: crypto.randomUUID().replace(/-/g, ""),
        device_model: "ytlr::",
      }),
    });

    const codeData = await codeRes.json() as Record<string, unknown>;
    logger.info({ userCode: codeData["user_code"] }, "OAuth2 device code received");

    authState = {
      status: "pending",
      userCode: codeData["user_code"] as string,
      verificationUrl: codeData["verification_url"] as string,
      deviceCode: codeData["device_code"] as string,
      interval: (codeData["interval"] as number) ?? 5,
      pollTimer: null,
    };

    startPolling();

    return res.json({
      status: "pending",
      userCode: authState.userCode,
      verificationUrl: authState.verificationUrl,
    });
  } catch (err) {
    logger.error({ err }, "Failed to get OAuth2 device code");
    return res.status(500).json({ status: "error", message: "Failed to reach Google auth servers" });
  }
});

// GET /api/auth/youtube/status
router.get("/status", (_req: Request, res: Response) => {
  const connected = isOAuthTokenCached();
  if (connected) authState.status = "done";
  return res.json({
    connected,
    status: connected ? "done" : authState.status,
    userCode: authState.userCode,
    verificationUrl: authState.verificationUrl,
  });
});

// DELETE /api/auth/youtube — disconnect
router.delete("/", async (_req: Request, res: Response) => {
  stopPolling();
  try {
    if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
  } catch (err) {
    logger.warn({ err }, "Failed to delete OAuth2 token file");
  }
  try {
    await db.delete(appConfigTable).where(eq(appConfigTable.key, "youtube_oauth_token")).execute();
    logger.info("YouTube OAuth2 token deleted from DB");
  } catch (err) {
    logger.warn({ err }, "Failed to delete OAuth2 token from DB");
  }
  authState = { status: "idle", userCode: "", verificationUrl: "", deviceCode: "", interval: 5, pollTimer: null };
  return res.json({ disconnected: true });
});

export default router;
