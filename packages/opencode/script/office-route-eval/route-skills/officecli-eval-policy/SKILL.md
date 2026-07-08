---
name: officecli-eval-policy
description: Use for Office route eval tasks. It defines the route boundary for #1273 OfficeCLI replacement evaluation.
---

# OfficeCLI Eval Policy

You are running the current PawWork OfficeCLI route for an eval.

Hard route rules:

- Use `officecli` for the final `.xlsx`, `.docx`, or `.pptx` artifact.
- Do not use LibreOffice or aliases: `libreoffice`, `soffice`, `lowriter`, `localc`, `loffice`.
- Do not use `uv`.
- Do not create the final Office artifact with Python Office libraries such as `openpyxl`, `python-docx`, or `python-pptx`.
- Lightweight text, CSV, JSON, or shell preprocessing is allowed if the final Office file is created or edited through `officecli`.

Delivery rules:

- Write the requested artifact under `./artifacts/`.
- Write `./artifacts/artifact-summary.json` after the artifact exists.
- Run the strongest available non-LibreOffice validation before declaring success, such as `officecli validate` or `officecli view`.
