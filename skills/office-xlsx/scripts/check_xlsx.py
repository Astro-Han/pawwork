#!/usr/bin/env python3
"""Pre-delivery gate for the office-xlsx route: open the finished .xlsx with
openpyxl and verify it really has the structure the task demands (sheets,
real formulas, charts) before the run claims success. A clean OK here means
the workbook opens, the formulas are stored as formulas (not baked-in text),
and any required charts/objects are present.

Run through uv so openpyxl resolves from the mirror:
  uv run python <skill>/scripts/check_xlsx.py <book.xlsx> --min-sheets 1 [--require-formula] [--require-chart]
"""

import argparse
import sys

try:
    from openpyxl import load_workbook
except ImportError:
    print(
        "FAIL: openpyxl is not importable. Run this through 'uv run python ...' from the "
        "directory that holds the office-xlsx pyproject.toml (uv must be on PATH).",
        file=sys.stderr,
    )
    sys.exit(2)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("xlsx", help="path to the built .xlsx")
    parser.add_argument("--min-sheets", type=int, default=1, help="minimum worksheet count")
    parser.add_argument("--require-formula", action="store_true", help="need at least one real formula cell")
    parser.add_argument("--require-chart", action="store_true", help="need at least one chart object")
    args = parser.parse_args()

    try:
        wb = load_workbook(args.xlsx)
    except Exception as error:  # noqa: BLE001 - report any open failure as a gate failure
        print(f"FAIL: cannot open {args.xlsx}: {error}")
        return 1

    sheets = wb.sheetnames
    formula_cells = 0
    chart_count = 0
    populated_cells = 0
    for ws in wb.worksheets:
        chart_count += len(getattr(ws, "_charts", []))
        for row in ws.iter_rows():
            for cell in row:
                if cell.value is None:
                    continue
                populated_cells += 1
                # openpyxl marks formula cells with data_type "f"; also catch raw "=" strings.
                if cell.data_type == "f" or (isinstance(cell.value, str) and cell.value.startswith("=")):
                    formula_cells += 1

    problems: list[str] = []
    if len(sheets) < args.min_sheets:
        problems.append(f"expected at least {args.min_sheets} sheet(s), found {len(sheets)}")
    if populated_cells == 0:
        problems.append("workbook has no populated cells")
    if args.require_formula and formula_cells < 1:
        problems.append("task needs real formulas but no formula cell was found (values may be hard-coded)")
    if args.require_chart and chart_count < 1:
        problems.append("task needs a chart but no chart object was found")

    for problem in problems:
        print(f"FAIL: {problem}")
    if problems:
        print(f"FAIL: {len(problems)} structure gap(s). Fix the generator and rebuild; do not hand-edit the zip.")
        return 1
    print(
        f"OK: {len(sheets)} sheet(s), {populated_cells} populated cell(s), "
        f"{formula_cells} formula cell(s), {chart_count} chart(s) — workbook matches the brief."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
