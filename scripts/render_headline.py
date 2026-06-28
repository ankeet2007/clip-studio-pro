#!/usr/bin/env python3
"""
Render headline text (with emoji) to a transparent RGBA PNG file.
Auto-wraps based on actual pixel width and shrinks font size to fit.

Usage: python3 render_headline.py '<json_params>'
JSON params: { text, font_path, font_size, line_spacing, canvas_width, output_path,
               max_lines (optional, default 2), min_font_size (optional, default 36),
               side_margin (optional, default 60) }
Prints JSON to stdout: { "height": <int>, "lines": <int>, "font_size": <int> }
"""
import sys
import json
from PIL import Image, ImageFont
from pilmoji import Pilmoji


def measure(pilmoji, text, font, fallback_size):
    try:
        w, h = pilmoji.getsize(text, font=font)
        return w, h
    except Exception:
        return len(text) * (fallback_size // 2), fallback_size


def wrap_text_pixel(text, pilmoji, font, max_width, fallback_size):
    words = text.strip().split()
    lines = []
    current = ""
    for word in words:
        candidate = word if not current else current + " " + word
        w, _ = measure(pilmoji, candidate, font, fallback_size)
        if w <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines or [text or ""]


def main():
    params = json.loads(sys.argv[1])
    text = params["text"]
    font_path = params["font_path"]
    base_font_size = int(params["font_size"])
    line_spacing = int(params["line_spacing"])
    canvas_width = int(params["canvas_width"])
    output_path = params["output_path"]
    max_lines = int(params.get("max_lines", 2))
    min_font_size = int(params.get("min_font_size", 36))
    side_margin = int(params.get("side_margin", 60))
    # Optional cap on the rendered block height (e.g. the title bar). 0 = no cap.
    max_height = int(params.get("max_height", 0))

    max_line_width = canvas_width - 2 * side_margin
    probe = Image.new("RGBA", (10, 10), (0, 0, 0, 0))

    chosen_lines = None
    chosen_font = None
    chosen_size = base_font_size

    for size in range(base_font_size, min_font_size - 1, -4):
        try:
            font = ImageFont.truetype(font_path, size)
        except Exception:
            font = ImageFont.load_default()

        with Pilmoji(probe) as pilmoji:
            lines = wrap_text_pixel(text, pilmoji, font, max_line_width, size)
            widths = [measure(pilmoji, ln, font, size)[0] for ln in lines]

        block_height = len(lines) * (size + line_spacing) + line_spacing
        fits_height = (max_height <= 0) or (block_height <= max_height)

        if len(lines) <= max_lines and all(w <= max_line_width for w in widths) and fits_height:
            chosen_lines = lines
            chosen_font = font
            chosen_size = size
            break

    if chosen_lines is None:
        try:
            font = ImageFont.truetype(font_path, min_font_size)
        except Exception:
            font = ImageFont.load_default()
        with Pilmoji(probe) as pilmoji:
            chosen_lines = wrap_text_pixel(text, pilmoji, font, max_line_width, min_font_size)
        chosen_font = font
        chosen_size = min_font_size

    line_height = chosen_size + line_spacing
    total_height = len(chosen_lines) * line_height + line_spacing

    img = Image.new("RGBA", (canvas_width, total_height), (0, 0, 0, 0))
    y = 0
    with Pilmoji(img) as pilmoji:
        for line in chosen_lines:
            w, _ = measure(pilmoji, line, chosen_font, chosen_size)
            x = max(0, (canvas_width - w) // 2)
            pilmoji.text((x, y), line, font=chosen_font, fill=(255, 255, 255, 255))
            y += line_height

    img.save(output_path, "PNG")
    print(json.dumps({"height": total_height, "lines": len(chosen_lines), "font_size": chosen_size}))


if __name__ == "__main__":
    main()
