#!/usr/bin/env python3
"""Post-build gate for native PPTX eval routes: verify the finished .pptx
package really contains the assets the task demands (speaker notes, chart
XML, embedded media) before the run claims success. Mirrors the judge rules
in eval.ts (judgeArtifact) so a clean check here means a clean judge there.

Stdlib only; safe to run with plain python3 on every route.
"""

import argparse
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

    for problem in problems:
        print(f"FAIL: {problem}")
    if problems:
        print(f"FAIL: {len(problems)} asset gap(s). Fix the deck source and rebuild; do not hand-edit the zip.")
        return 1
    print(f"OK: {slides} slides, {notes} notes, {charts} chart xml, {media} media file(s) — package matches the brief.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
