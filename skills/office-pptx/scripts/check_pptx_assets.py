#!/usr/bin/env python3
"""Post-build gate for the office-pptx route: verify the finished .pptx
package really contains the assets the task demands (speaker notes, chart
XML, embedded media) before the run claims success. Covers package-asset
rules only; it does not check required text, explicit font sizes,
out-of-bounds shapes, or visual-slide density.

Stdlib only, but run it through uv for consistency with the rest of the
skill: uv run python <skill>/scripts/check_pptx_assets.py ...
"""

import argparse
import json
import pathlib
import re
import sys
import zipfile


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pptx", help="path to the built .pptx")
    parser.add_argument("--slides", type=int, required=True, help="expected slide count from the task brief")
    parser.add_argument("--require-chart", action="store_true", help="task is data-backed: need ppt/charts/chart*.xml")
    parser.add_argument("--require-media", action="store_true", help="task has image evidence: need ppt/media/*")
    args = parser.parse_args()

    try:
        zf = zipfile.ZipFile(args.pptx)
    except (OSError, zipfile.BadZipFile) as error:
        print(f"FAIL: cannot open {args.pptx}: {error}")
        return 1

    names = zf.namelist()
    slides = sum(1 for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n))
    notes = sum(1 for n in names if re.fullmatch(r"ppt/notesSlides/notesSlide\d+\.xml", n))
    charts = sum(1 for n in names if n.startswith("ppt/charts/chart"))
    media = sum(1 for n in names if n.startswith("ppt/media/"))

    problems: list[str] = []
    if slides != args.slides:
        problems.append(f"expected {args.slides} slides, found {slides}")
    # Judge rule: notesCount >= max(1, expectedSlides - 1)
    min_notes = max(1, args.slides - 1)
    if notes < min_notes:
        problems.append(f"need speaker notes on at least {min_notes} slides, found {notes} notesSlide xml parts")
    if args.require_chart and charts < 1:
        problems.append("data-backed task but no ppt/charts/chart*.xml (native editable chart missing)")
    if args.require_media and media < 1:
        problems.append("image task but ppt/media/ is empty (image was not embedded in the package)")
    summary = pathlib.Path(args.pptx).parent / "artifact-summary.json"
    if not summary.is_file():
        problems.append(f"missing {summary} (write it before running this gate)")
    else:
        try:
            data = json.loads(summary.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            problems.append(f"{summary} is not valid JSON: {error}")
        else:
            if not isinstance(data, dict):
                problems.append(f"{summary} must be a JSON object")
            else:
                if not isinstance(data.get("renderer"), str) or not data["renderer"].strip():
                    problems.append(f"{summary} needs a non-empty string key 'renderer'")
                slides_meta = data.get("slides")
                if not isinstance(slides_meta, list) or len(slides_meta) == 0:
                    problems.append(f"{summary} needs a non-empty array key 'slides' (one entry per slide)")

    for problem in problems:
        print(f"FAIL: {problem}")
    if problems:
        print(f"FAIL: {len(problems)} asset gap(s). Fix the deck source and rebuild; do not hand-edit the zip.")
        return 1
    print(f"OK: {slides} slides, {notes} notes, {charts} chart xml, {media} media file(s) — package matches the brief.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
