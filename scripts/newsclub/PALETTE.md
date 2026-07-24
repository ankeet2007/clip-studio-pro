# NewsClub — Video Design System (v1)

**Direction B · Editorial Clean · Deep Indigo.** Chosen 2026-07-24 against a rendered preview.
Clean, professional, whitespace-forward — trust over noise. Applied to Clip 6 onward.

## Palette
| Token   | Hex        | RGB            | ASS (`&HBBGGRR`) | Use |
|---------|------------|----------------|------------------|-----|
| Indigo  | `#3452FF`  | 52, 82, 255    | `&HFF5234&`      | the wordmark dot, the kicker tick, the card edge |
| Glow    | `#8298FF`  | 130, 152, 255  | `&HFF9882&`      | progress hairline, **the one highlighted caption word per line** |
| White   | `#FFFFFF`  | 255,255,255    | `&HFFFFFF&`      | wordmark, caption body, source |
| Footage | —          | (real clip)    | —                | near-black grounds; keep the frame breathing |

One accent only. Indigo carries identity; everything else stays quiet.

## Type
- **Family: Inter** (single family, whole system). Variable TTF at `fonts/Inter.ttf`.
- Wordmark / kicker: **SemiBold**. Captions: **Medium/Regular** (libass renders the variable
  font at a clean regular weight; the highlight is by colour, not weight).
- Anton is NOT used in Direction B (it's a condensed display face — off-brief for editorial).

## Layout (canvas 1080×1920)
- **Wordmark** "NewsClub ·" — centred, y≈54. Dot in indigo.
- **Progress** — indigo-glow hairline, 6px, top edge, slides L→R to fill over the clip.
- **Kicker** — indigo tick + letter-spaced UPPERCASE beat label, content top y≈1228 (`0.64·H`), x=72.
- **Captions** — Inter, 52px, left-aligned, pinned `\pos(72,1300)`, one indigo-glow word/line.
- **Source tag** — "via X · @handle", small, bottom-right, content top y≈1632 (`0.85·H`).
- **Endcard** — "STAY INFORMED" + big "NewsClub ·" + a short indigo rule, centred.
- **Tweet cards** — real screenshot on a rounded indigo-edged card + soft shadow, centred.

## Safe zones
Keep all chrome inside `x ∈ [72, 1008]`. Keep the bottom ~330px and right ~140px clear of
caption/branding (YouTube Shorts action rail + title/progress overlap).

## Motion
Minimal. Kicker + source fade in/out (0.3s). Progress fills over the clip. Nothing else.

## Files
- `nc_brand.py` — PIL overlay generators: `wordmark()`, `kicker(text)`, `source_tag(text)`,
  `scrim()`, `endcard()`, `tweet_card(shot)`. Run it for a self-test preview.
- `nc_render.py` — builds `captions.ass` (speech-flow timing + highlight) + `job.json`
  (ffmpeg filter_complex, relative paths) for the Colab `/worker/ffmpeg-job`. `--selftest`
  renders a local preview frame. It copies `Inter.ttf` into the bundle so `subtitles=…:fontsdir=.`
  resolves on the worker (same mechanism clips 4/5 used with Anton).
- `fonts/Inter.ttf` — the caption + chrome font.

## Colab / render notes
No worker changes needed — the box already runs the generic `ffmpeg-job` with **libx265** and
**libass/fontsdir** (used by clips 4/5). Requirements: the tar bundle must contain the overlay
PNGs, `captions.ass`, `Inter.ttf`, the trimmed segments, and the VO. HEVC on Colab CPU is slow
(~7min for ~70s) — expected. Verified end-to-end through the tablet's ffmpeg+libass smoke test.
