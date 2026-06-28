#!/usr/bin/env python3
"""
Analyze a frame to detect if there's already a logo/watermark in the
bottom-center region where our channel handle watermark would go.

Usage: python3 detect_watermark_overlap.py '<json_params>'
JSON params: { frame_path, region_w, region_h, frame_w, frame_h }
Prints JSON to stdout: { "busy": <bool>, "stddev": <float> }
"""
import sys
import json
from PIL import Image
import statistics

def main():
    params = json.loads(sys.argv[1])
    frame_path = params["frame_path"]
    region_w = int(params["region_w"])
    region_h = int(params["region_h"])
    frame_w = int(params["frame_w"])
    frame_h = int(params["frame_h"])

    img = Image.open(frame_path).convert("L")  # grayscale

    cx = frame_w // 2
    x0 = max(0, cx - region_w // 2)
    x1 = min(frame_w, cx + region_w // 2)
    y1 = frame_h
    y0 = max(0, frame_h - region_h)

    crop = img.crop((x0, y0, x1, y1))
    pixels = list(crop.getdata())
    sd = statistics.pstdev(pixels) if len(pixels) > 1 else 0.0

    # Higher stddev = more visual complexity (text/logo edges) = likely existing watermark
    busy = sd > 25.0

    print(json.dumps({"busy": busy, "stddev": round(sd, 2)}))

if __name__ == "__main__":
    main()
