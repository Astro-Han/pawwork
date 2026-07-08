---
name: python-office-eval
description: Use for Python + uv Office eval tasks. It defines the replacement-route boundary for #1273.
---

# Python Office Eval

You are running the Python + uv + skills route for an Office artifact eval.

Hard route rules:

- Use `uv` and Python to create the requested `.xlsx`, `.docx`, or `.pptx`.
- Do not call `officecli`.
- Do not use LibreOffice or aliases: `libreoffice`, `soffice`, `lowriter`, `localc`, `loffice`.
- Use the provided `pyproject.toml` in the working directory. It includes `openpyxl`, `python-docx`, and `python-pptx`.

Preferred build pattern:

1. Write a small Python script in the working directory.
2. Run it with `uv run python <script>.py`.
3. Inspect the generated OOXML zip or reopen with the same Python library for validation.
4. Write `./artifacts/artifact-summary.json`.

Quality floor:

- `.xlsx`: formulas for computed values, readable column widths, frozen header row, at least one chart.
- `.docx`: explicit heading hierarchy, a table when requested, footer with a live page-number field.
- `.pptx`: six requested slides, explicit font sizes, speaker notes on content slides, at least one chart.
