# Clip Studio — cloud render worker (GitHub Codespace)

Free, no-card cloud box that renders clips so the phone doesn't OOM/crawl. The phone downloads
on its home IP, offloads the render to this worker over a cloudflared tunnel (async submit→poll→
download), and falls back to local rendering if the cloud is off.

## Turn it on/off (from the tablet's Termux)
    cloud on      # resume box + worker + tunnel, point the phone at it
    cloud off     # stop the codespace (phone falls back to local)
    cloud status  # gh codespace list
    cloud usage   # this month's core-hours used + free budget left
    usage         # same as `cloud usage` (standalone command)

`cloud` = `/data/data/com.termux/files/usr/bin/cloud` (see cloud-termux-cmd.sh); it runs
`proot-distro login alpine -- bash /root/cloud-on.sh` (self-contained scripts, copies here).
`usage` estimates GitHub Codespaces core-hours from the `cloud on`/`cloud off` times logged to
`~/cloud-usage.log` (120 core-hrs/month free = 30 wall-hrs at 4 cores); exact figure lives at
github.com/settings/billing.

## Files
- `setup.sh`  — one-shot toolchain on a fresh codespace (ffmpeg, whisper.cpp+models, piper+ALL voices, pilmoji, build)
- `run.sh`    — start worker + tunnel, print URL + secret
- `cloud-on.sh` / `cloud-off.sh` — tablet-side on/off (codespace name hardcoded)
- `scripts/`  — x86_64-adapted caption/voiceover scripts installed into ~/myapp/scripts

Worker code: `artifacts/api-server-pro/src/worker.ts`. Phone offload: `clipProcessor.ts`
(`offloadToCloud` + `tryCloudMultiSegment`, both async).
