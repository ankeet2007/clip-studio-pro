#!/usr/bin/env python3
"""NewsClub video design kit — Direction B (Editorial Clean · Deep Indigo).

PIL generators for the on-screen chrome overlays. Each returns a tightly-cropped
RGBA PNG (with a baked soft shadow + transparent PAD margin) that nc_render.py
composites onto the footage with ffmpeg `overlay`. Captions are handled in ASS by
nc_render; the animated progress hairline is an ffmpeg drawbox.

Run directly (`python3 nc_brand.py`) for a self-test preview over placeholder footage.
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, "fonts", "Inter.ttf")
W, H = 1080, 1920
PAD = 22                      # transparent margin baked around each element (room for shadow)

# ---- palette: Deep Indigo ----
INDIGO = (52, 82, 255)        # accent — the dot, the kicker tick
GLOW   = (130, 152, 255)      # brighter indigo — hairline + highlighted caption word
WHITE  = (255, 255, 255)
SAFE_X = 72                   # chrome inset from frame edges

_fc = {}
def font(size, weight="Regular"):
    k = (int(size), weight)
    if k not in _fc:
        f = ImageFont.truetype(FONT, int(size))
        try: f.set_variation_by_name(weight)
        except Exception: pass
        _fc[k] = f
    return _fc[k]

# segment = (text, rgb, size, weight)
def _measure(segs, tracking):
    d = ImageDraw.Draw(Image.new("RGBA", (4, 4)))
    w = 0.0; asc = desc = 0
    for text, _c, size, wt in segs:
        fo = font(size, wt)
        for ch in text:
            w += d.textlength(ch, font=fo) + tracking
        a, de = fo.getmetrics(); asc = max(asc, a); desc = max(desc, de)
    return int(round(w)), asc, desc

def text_png(segs, tracking=0, shadow=True, shadow_rgba=(0, 0, 0, 165), blur=7):
    """Render a horizontal multi-segment run to a tight RGBA PNG with a soft shadow."""
    w, asc, desc = _measure(segs, tracking)
    cw, ch = w + 2 * PAD, asc + desc + 2 * PAD
    def paint(canvas, fill_override=None, dx=0, dy=0):
        d = ImageDraw.Draw(canvas); x = PAD + dx
        for text, col, size, wt in segs:
            fo = font(size, wt)
            fill = fill_override if fill_override else col + (255,)
            for c in text:
                d.text((x, PAD + dy), c, font=fo, fill=fill)
                x += d.textlength(c, font=fo) + tracking
    img = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    if shadow:
        sh = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        paint(sh, fill_override=shadow_rgba, dy=2)
        img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(blur)))
    paint(img)
    return img

# ---------------- elements ----------------
def wordmark():
    """Centered top wordmark: 'NewsClub ·' (dot in indigo)."""
    return text_png([("NewsClub", WHITE, 40, "SemiBold"), (" ·", GLOW, 40, "SemiBold")])

def kicker(text):
    """Lower-third beat label: indigo tick + letter-spaced uppercase label."""
    label = text.upper()
    img = text_png([(label, (235, 236, 245), 27, "SemiBold")], tracking=3)
    # indigo tick to the left of the text (inside the PAD gutter)
    d = ImageDraw.Draw(img)
    ty0 = PAD + 4; ty1 = img.height - PAD - 4
    d.rectangle([PAD - 14, ty0, PAD - 8, ty1], fill=GLOW + (255,))
    return img

def source_tag(text):
    """Small bottom-right credit: 'via X · @handle'."""
    return text_png([(text, (255, 255, 255), 26, "Medium")],
                    shadow_rgba=(0, 0, 0, 140))

def endcard():
    """Full-frame centered outro: 'STAY INFORMED' + big 'NewsClub ·' wordmark."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    kick = text_png([("STAY INFORMED", (225, 227, 240), 30, "SemiBold")], tracking=6)
    big  = text_png([("NewsClub", WHITE, 88, "SemiBold"), (" ·", GLOW, 88, "SemiBold")])
    rule_w = 120
    img.alpha_composite(kick, ((W - kick.width) // 2, int(H * 0.44)))
    img.alpha_composite(big,  ((W - big.width) // 2, int(H * 0.475)))
    d = ImageDraw.Draw(img)
    d.rectangle([(W - rule_w) // 2, int(H * 0.60), (W + rule_w) // 2, int(H * 0.60) + 4], fill=GLOW + (255,))
    return img

def tweet_card(screenshot_path, max_w=980):
    """Composite a REAL tweet screenshot onto a rounded indigo-edged card with a soft
    drop shadow — returned as a full-frame overlay, centred. (Real screenshot beats a
    rendered fake — see prior NewsClub learnings.)"""
    shot = Image.open(screenshot_path).convert("RGB")
    r = max_w / shot.width
    cw, ch = max_w, int(shot.height * r)
    shot = shot.resize((cw, ch))
    b = 5  # indigo edge thickness
    card = Image.new("RGBA", (cw + 2 * b, ch + 2 * b), (0, 0, 0, 0))
    ImageDraw.Draw(card).rounded_rectangle([0, 0, cw + 2 * b - 1, ch + 2 * b - 1], radius=28, fill=INDIGO + (255,))
    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, cw - 1, ch - 1], radius=23, fill=255)
    card.paste(shot, (b, b), mask)
    frame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    x, y = (W - card.width) // 2, (H - card.height) // 2
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([x, y + 10, x + card.width, y + 10 + card.height], radius=30, fill=(0, 0, 0, 150))
    frame.alpha_composite(sh.filter(ImageFilter.GaussianBlur(24)))
    frame.alpha_composite(card, (x, y))
    return frame

def scrim():
    """Full-frame legibility scrim: gentle bottom darken + a touch at the very top."""
    sc = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(sc)
    for y in range(H):
        t = y / (H - 1); a = 0
        if t > 0.42:
            a = int(190 * ((t - 0.42) / 0.58) ** 1.5)
        if t < 0.10:
            a = max(a, int(70 * (1 - t / 0.10)))
        d.line([(0, y), (W, y)], fill=(0, 0, 0, a))
    return sc

# ---------------- CLI: emit assets + self-test ----------------
def _placeholder_footage():
    base = Image.new("RGB", (W, H)); d = ImageDraw.Draw(base)
    for y in range(H):
        t = y / (H - 1)
        c = tuple(int(a + (b - a) * t) for a, b in zip((13, 20, 40), (5, 8, 15)))
        d.line([(0, y), (W, y)], fill=c)
    g = Image.new("L", (W, H), 0)
    ImageDraw.Draw(g).ellipse([int(W*0.1), int(H*0.55), int(W*0.95), int(H*0.8)], fill=255)
    g = g.filter(ImageFilter.GaussianBlur(150))
    base = Image.composite(Image.new("RGB", (W, H), (150, 90, 45)), base, g.point(lambda a: int(a*0.5)))
    return base.convert("RGBA")

if __name__ == "__main__":
    out = os.path.join(HERE, "out"); os.makedirs(out, exist_ok=True)
    assets = {
        "wordmark.png": wordmark(),
        "kicker.png": kicker("Modi breaks silence"),
        "source.png": source_tag("via X · @user"),
        "scrim.png": scrim(),
        "endcard.png": endcard(),
    }
    for name, im in assets.items():
        im.save(os.path.join(out, name)); print("wrote", name, im.size)

    # self-test: place elements the way nc_render will, then downscale + save for review
    frame = _placeholder_footage()
    frame.alpha_composite(assets["scrim.png"])
    # progress hairline (static preview of ~40%)
    ImageDraw.Draw(frame).rectangle([0, 0, int(W * 0.40), 6], fill=GLOW + (255,))
    wm = assets["wordmark.png"]; frame.alpha_composite(wm, ((W - wm.width) // 2, 54 - PAD))
    ky = int(H * 0.64)
    kk = assets["kicker.png"]; frame.alpha_composite(kk, (SAFE_X - PAD + 14, ky - PAD))
    sr = assets["source.png"]; frame.alpha_composite(sr, (W - SAFE_X - sr.width + PAD, int(H*0.85) - PAD))
    # fake a caption line (nc_render does this in ASS) to sanity-check the stack
    d = ImageDraw.Draw(frame)
    cf = font(52, "Medium"); cx, cyy = SAFE_X, ky + 66
    for seg, col in [("Modi called it a ", WHITE), ("grave sin", GLOW), (" and vowed", WHITE)]:
        d.text((cx, cyy), seg, font=cf, fill=col + (255,), stroke_width=3, stroke_fill=(0, 0, 0, 200))
        cx += d.textlength(seg, font=cf)
    frame.convert("RGB").resize((540, 960), Image.LANCZOS).save(os.path.join(out, "_selftest.png"))
    print("wrote _selftest.png")
