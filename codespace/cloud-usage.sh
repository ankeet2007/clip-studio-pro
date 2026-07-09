#!/usr/bin/env bash
# Show THIS MONTH's GitHub Codespace usage (estimated) + free budget remaining.
# Usage is tracked from `cloud on` / `cloud off` timestamps in ~/cloud-usage.log; the live
# codespace state (via `gh codespace view`) resolves an open session (running now vs idle-stopped).
CS=super-duper-capybara-wvrxj4p9r955c5wj4
LOG="$HOME/cloud-usage.log"
FREE_CORE_HOURS=120     # GitHub Free personal: 120 core-hours/month
CORES=4                 # this codespace = 4 cores → 120 core-hrs = 30 wall-hrs

INFO=$(gh codespace view -c "$CS" --json state,machineDisplayName,lastUsedAt 2>/dev/null)
[ -z "$INFO" ] && INFO='{}'

node -e '
const fs = require("fs");
const info = JSON.parse(process.argv[1] || "{}");
const logPath = process.argv[2];
const FREE = Number(process.argv[3]), CORES = Number(process.argv[4]);
const now = Math.floor(Date.now() / 1000);
const d = new Date();
const monthStart = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
const state = info.state || "unknown";
const lastUsed = info.lastUsedAt ? Math.floor(Date.parse(info.lastUsedAt) / 1000) : now;

let lines = [];
try { lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/); } catch { /* no log yet */ }

let openStart = null, wall = 0;
const add = (a, b) => { const lo = Math.max(a, monthStart), hi = Math.min(b, now); if (hi > lo) wall += hi - lo; };
for (const ln of lines) {
  const m = ln.trim().match(/^(on|off)\s+(\d+)/);
  if (!m) continue;
  const ev = m[1], t = Number(m[2]);
  if (ev === "on") { if (openStart === null) openStart = t; }
  else { if (openStart !== null) { add(openStart, t); openStart = null; } }
}
// Trailing open session: still running ⇒ up to now; otherwise it idle-stopped ⇒ approx at lastUsedAt.
if (openStart !== null) { add(openStart, state === "Available" ? now : Math.max(openStart, lastUsed)); }

const wallH = wall / 3600;
const usedCore = wallH * CORES;
const leftCore = Math.max(0, FREE - usedCore);
const pct = Math.min(100, FREE ? (usedCore / FREE) * 100 : 0);
const bars = Math.round(pct / 5);
const bar = "█".repeat(bars) + "░".repeat(Math.max(0, 20 - bars));
const H = (h) => h.toFixed(1);
const month = d.toLocaleString("en-US", { month: "long", year: "numeric" });

console.log("");
console.log("  ☁️  GitHub Codespace usage — " + month);
console.log("  ────────────────────────────────────────────");
console.log("  Machine : " + (info.machineDisplayName || "?"));
console.log("  State   : " + (state === "Available" ? "🟢 ON (running now)" : "⚪ " + state));
console.log("");
console.log("  [" + bar + "] " + pct.toFixed(0) + "%");
console.log("  Used    : " + H(usedCore) + " / " + FREE + " core-hours   (" + H(wallH) + " wall-hrs @ " + CORES + " cores)");
console.log("  Left    : " + H(leftCore) + " core-hours   (~" + H(leftCore / CORES) + " wall-hrs of runtime left)");
console.log("");
console.log("  * Estimated from cloud on/off this month (idle auto-stops approximated).");
console.log("    Exact billing: https://github.com/settings/billing");
console.log("");
' "$INFO" "$LOG" "$FREE_CORE_HOURS" "$CORES"
