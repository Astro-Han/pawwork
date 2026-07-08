#!/usr/bin/env python3
"""Pre-conversion gate for the svg-pptx route: fail when any SVG text line
would render past the slide safe edge. Uses the converter's own width
estimator so the check matches the DrawingML boxes it will produce."""

from __future__ import annotations

import re
import sys
import unicodedata
from pathlib import Path

SAFE_RIGHT = 1220.0
SAFE_LEFT = 20.0


def is_cjk_char(ch: str) -> bool:
    return unicodedata.east_asian_width(ch) in ("W", "F")


def estimate_text_width(text: str, font_size: float, font_weight: str = "400") -> float:
    # Must stay in sync with svg_to_pptx/drawingml/utils.py:estimate_text_width,
    # so this pre-check agrees with the DrawingML boxes the converter emits.
    width = 0.0
    for ch in text:
        if is_cjk_char(ch):
            width += font_size
        elif ch == " ":
            width += font_size * 0.3
        elif ch in "mMwWOQ%":
            width += font_size * 0.75
        elif ch in "iIlj!|":
            width += font_size * 0.3
        else:
            width += font_size * 0.55
    if font_weight in ("bold", "600", "700", "800", "900"):
        width *= 1.05
    return width

def attr(source: str, name: str) -> str | None:
    # Anchor on a word boundary so short names like "x" do not match inside "dx="/"rx=".
    match = re.search(rf'\b{re.escape(name)}="([^"]*)"', source) or re.search(rf"\b{re.escape(name)}:\s*([^;\"']+)", source)
    return match.group(1).strip() if match else None


def numeric(value: str | None, fallback: float) -> float:
    # Tolerate unit suffixes like "60px": fail with a report line, not a traceback.
    if value is None:
        return fallback
    match = re.match(r"[-+]?\d*\.?\d+", value)
    return float(match.group(0)) if match else fallback


def check_file(svg_path: Path) -> list[str]:
    problems: list[str] = []
    content = svg_path.read_text(encoding="utf-8")
    for match in re.finditer(r"<text\b([^>]*)>(.*?)</text>", content, re.S):
        attrs, body = match.group(1), match.group(2)
        text = re.sub(r"<[^>]+>", "", body).strip()
        if not text:
            continue
        x = numeric(attr(attrs, "x"), 0)
        font_size = numeric(attr(attrs, "font-size"), 16)
        weight = attr(attrs, "font-weight") or "400"
        anchor = attr(attrs, "text-anchor") or "start"
        width = estimate_text_width(text, font_size, weight)
        if anchor == "middle":
            left, right = x - width / 2, x + width / 2
        elif anchor == "end":
            left, right = x - width, x
        else:
            left, right = x, x + width
        if right > SAFE_RIGHT or left < SAFE_LEFT:
            over = max(right - SAFE_RIGHT, SAFE_LEFT - left)
            problems.append(
                f'{svg_path.name}: {over:.0f}px past safe edge at font-size {font_size:.0f}px: "{text[:60]}"'
            )
    return problems


def main() -> int:
    svg_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("deck/svg_output")
    files = sorted(svg_dir.glob("*.svg"))
    if not files:
        print(f"no SVG files found in {svg_dir}", file=sys.stderr)
        return 2
    problems = [p for f in files for p in check_file(f)]
    for problem in problems:
        print(problem)
    if problems:
        print(f"FAIL: {len(problems)} text line(s) exceed the safe area. Shorten or split them.")
        return 1
    print(f"OK: all text lines in {len(files)} SVG file(s) fit the safe area.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
