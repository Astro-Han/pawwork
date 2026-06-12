---
name: officecli-current
description: Use for PPT quality eval tasks that must use the current PawWork OfficeCLI route.
---

# OfficeCLI Current PPT Eval

You are running the current PawWork OfficeCLI route for a PPT quality eval.

Hard route rules:

- Use `officecli` for the final `.pptx` artifact.
- Do not use `uv`.
- Do not use `python-pptx` or PptxGenJS for the final artifact.
- Do not use LibreOffice or aliases: `libreoffice`, `soffice`, `lowriter`, `localc`, `loffice`.

Quality floor:

- Use conclusion titles, not topic labels.
- Set explicit font sizes on every text shape: slide titles must be at least 44pt, body text must be at least 18pt, and titles must be at least 2x the body size.
- Include a visual object on every slide.
- Add speaker notes on content slides.
- Use the strongest non-LibreOffice validation available, such as `officecli validate`, `officecli view text`, or `officecli view issues`.
- Write `./artifacts/artifact-summary.json` with renderer, slide titles, layout names, visual rules applied, and limitations.
