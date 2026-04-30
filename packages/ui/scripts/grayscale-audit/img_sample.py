#!/usr/bin/env python3
"""Pixel sampling helpers for the grayscale audit scripts.

Pure helpers — no top-level I/O. Importable from token_audit.py / chatgpt_gap_audit.py /
dark_audit.py. Each function operates on a Pillow `Image` (RGB mode) plus integer pixel
coordinates already converted to retina (2x) space by the caller.
"""
import statistics


def to_hex(rgb):
    return "#{:02X}{:02X}{:02X}".format(*rgb[:3])


def lab_l(rgb):
    """CIE L* perceptual lightness."""

    def f(c):
        c = c / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (f(c) for c in rgb[:3])
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if y > 0.008856:
        lstar = 116 * (y ** (1 / 3)) - 16
    else:
        lstar = 903.3 * y
    return round(lstar, 1)


def median_region(img, x1, y1, x2, y2):
    """Median color in a rectangle (good for plain backgrounds)."""
    px = img.load()
    rs, gs, bs = [], [], []
    for y in range(y1, y2):
        for x in range(x1, x2):
            r, g, b = px[x, y][:3]
            rs.append(r)
            gs.append(g)
            bs.append(b)
    return (
        int(statistics.median(rs)),
        int(statistics.median(gs)),
        int(statistics.median(bs)),
    )


def darkest_region(img, x1, y1, x2, y2, pct=2.0):
    """Representative ink color: 2nd percentile darkest pixel (skips pure-black AA artifacts)."""
    px = img.load()
    pixels = []
    for y in range(y1, y2):
        for x in range(x1, x2):
            r, g, b = px[x, y][:3]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            pixels.append((lum, r, g, b))
    pixels.sort(key=lambda p: p[0])
    idx = max(1, int(len(pixels) * pct / 100))
    pool = pixels[:idx]
    rmed = int(statistics.median(p[1] for p in pool))
    gmed = int(statistics.median(p[2] for p in pool))
    bmed = int(statistics.median(p[3] for p in pool))
    return (rmed, gmed, bmed)


def text_row_height(img, x1, y1, x2, y2, threshold_lum=200):
    """Estimate text glyph height by counting consecutive vertical rows containing ink pixels."""
    px = img.load()
    rows_with_ink = []
    for y in range(y1, y2):
        has_ink = False
        for x in range(x1, x2):
            r, g, b = px[x, y][:3]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            if lum < threshold_lum:
                has_ink = True
                break
        rows_with_ink.append(has_ink)
    runs = []
    current = 0
    for has_ink in rows_with_ink:
        if has_ink:
            current += 1
        else:
            if current > 0:
                runs.append(current)
            current = 0
    if current > 0:
        runs.append(current)
    return max(runs) if runs else 0


def lightest_below_white(img, x1, y1, x2, y2, threshold=253):
    """Lightest pixel that's not pure-white-ish (good for finding subtle bg differentiation)."""
    px = img.load()
    best = (0, 0, 0)
    best_l = -1
    for y in range(y1, y2):
        for x in range(x1, x2):
            r, g, b = px[x, y][:3]
            if r >= threshold and g >= threshold and b >= threshold:
                continue
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            if lum > best_l:
                best_l = lum
                best = (r, g, b)
    return best
