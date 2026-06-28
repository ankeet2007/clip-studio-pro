import fs from "fs";
import os from "os";
import path from "path";

const SETTINGS_FILE = path.join(os.homedir(), "myapp", "clips_settings.json");
const DEFAULT_CHANNEL_HANDLE = "@THEY CALL ME A SHOT";

export interface AppSettings {
  channelHandle: string;
}

export function readSettings(): AppSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Partial<AppSettings>;
      return { channelHandle: raw.channelHandle ?? DEFAULT_CHANNEL_HANDLE };
    }
  } catch {}
  return { channelHandle: DEFAULT_CHANNEL_HANDLE };
}

export function writeSettings(data: Partial<AppSettings>): AppSettings {
  const current = readSettings();
  const updated: AppSettings = { ...current, ...data };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2));
  return updated;
}
