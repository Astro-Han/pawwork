#!/usr/bin/env python3
"""Ad-hoc font-size measurement utility for retina (2x) screenshots.

Not a PASS/FAIL audit — used during commits 8-11 to spot-check rendered glyph height
when a font-size question arises. Caller supplies a screenshot, a starting x, and a
y-band that fully contains the line; the script finds the first ink glyph in that
band, measures its tight bbox, and reports a font-size estimate based on a typical
typographic ratio for the given script.
"""
import argparse
import sys

from PIL import Image


def find_first_glyph_x(img, y_start, y_end, x_search_start, x_search_end, dark_text=True, threshold=180):
    """Scan x-columns within y-band, find first column with ink. Returns x or None."""
    px = img.load()
    for x in range(x_search_start, x_search_end):
        for y in range(y_start, y_end):
            r, g, b = px[x, y][:3]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            is_ink = (lum < threshold) if dark_text else (lum > threshold)
            if is_ink:
                return x
    return None


def find_letter_at(img, x_start, x_end, y_start, y_end, dark_text=True, threshold=180):
    """Tight bbox of ink within a rect. Returns (min_x, min_y, max_x, max_y, w, h) or None."""
    px = img.load()
    min_x, min_y, max_x, max_y = None, None, None, None
    for y in range(y_start, y_end):
        for x in range(x_start, x_end):
            r, g, b = px[x, y][:3]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            is_ink = (lum < threshold) if dark_text else (lum > threshold)
            if is_ink:
                if min_x is None or x < min_x:
                    min_x = x
                if min_y is None or y < min_y:
                    min_y = y
                if max_x is None or x > max_x:
                    max_x = x
                if max_y is None or y > max_y:
                    max_y = y
    if min_x is None:
        return None
    return (min_x, min_y, max_x, max_y, max_x - min_x + 1, max_y - min_y + 1)


def measure(screenshot, x, y_top, y_bottom, script):
    """Measure rendered font size of the first glyph in the given y-band of `screenshot`.

    Args:
        screenshot: path to a 2x retina PNG.
        x: x-search start (image px).
        y_top, y_bottom: y-band bounding the line.
        script: one of "latin-caps" or "chinese-ink".

    Returns:
        (measured_pt, observed_px) — measured_pt is the estimated CSS font-size in
        logical px (computed from glyph height / typographic ratio); observed_px is
        the raw glyph height in retina px.
    """
    img = Image.open(screenshot).convert("RGB")
    # Default to dark-on-light. For current grayscale-audit usage (light + dark
    # PawWork screenshots), dark_text=True with a moderate threshold works.
    # Add an explicit CLI flag if light-on-dark inversion is ever needed.
    dark_text = True
    threshold = 180

    x0 = find_first_glyph_x(img, y_top, y_bottom, x, x + 200, dark_text=dark_text, threshold=threshold)
    if x0 is None:
        raise RuntimeError(f"No glyph found in y={y_top}-{y_bottom}, x>={x} in {screenshot}")
    bbox = find_letter_at(img, x0, x0 + 36, y_top, y_bottom, dark_text=dark_text, threshold=threshold)
    if bbox is None:
        raise RuntimeError(f"No bbox at x0={x0} in {screenshot}")
    narrow = find_letter_at(img, bbox[0], bbox[2] + 1, bbox[1], bbox[3] + 1, dark_text=dark_text, threshold=threshold)
    if narrow is None:
        raise RuntimeError(f"No narrow bbox in {screenshot}")
    observed_px = narrow[5]
    h_logical = observed_px / 2  # 2x retina

    if script == "latin-caps":
        ratio = 0.70
    elif script == "chinese-ink":
        ratio = 0.88
    else:
        raise ValueError(f"Unknown script: {script}")

    measured_pt = h_logical / ratio
    return (measured_pt, observed_px)




def _cli():
    parser = argparse.ArgumentParser(description="Measure rendered font size from a retina screenshot.")
    parser.add_argument("screenshot", help="path to a 2x retina PNG")
    parser.add_argument("--x", type=int, required=True, help="x of glyph search start (image px)")
    parser.add_argument("--y-top", type=int, required=True)
    parser.add_argument("--y-bottom", type=int, required=True)
    parser.add_argument("--script", choices=["latin-caps", "chinese-ink"], default="latin-caps")
    args = parser.parse_args()
    pt, px = measure(args.screenshot, args.x, args.y_top, args.y_bottom, args.script)
    print(f"{pt:.1f}pt observed ({px}px glyph height)")
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
