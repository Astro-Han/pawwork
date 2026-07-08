---
name: python-pptx-native
description: Use for PPT quality eval tasks that must create editable native PPTX with Python and uv.
---

# Python PPTX Native Eval

You are running the Python + uv native PPTX route for a PPT quality eval.

Hard route rules:

- Use `uv run python` and `python-pptx` to create the final `.pptx`.
- Do not call `officecli`.
- Do not call `node` for the final artifact.
- Do not use LibreOffice or aliases: `libreoffice`, `soffice`, `lowriter`, `localc`, `loffice`.
- Use the provided `pyproject.toml` in the working directory.

Quality floor:

- Keep all output editable: real text boxes, real charts when practical, speaker notes on content slides.
- Set explicit font sizes on title and body runs: slide titles must be at least 44pt, body text must be at least 18pt, and titles must be at least 2x the body size.
- Use conclusion titles, not topic labels.
- Include a visual object on every slide: chart, image, process diagram, KPI block, or structured shape system.
- Add speaker notes (`slide.notes_slide.notes_text_frame.text = ...`) to every content slide; embed task images with `add_picture` so the package contains `ppt/media/`.
- Write `./artifacts/artifact-summary.json` with renderer, slide titles, layout names, visual rules applied, and limitations.
- Then run the package gate as the LAST step and fix every reported gap (rebuild via your script; never hand-edit the zip) until it prints OK:

  ```
  python3 "$PPTX_CHECK_SCRIPT" ./artifacts/<artifact-name>.pptx --slides <N> [--require-chart] [--require-media]
  ```

  Pass `--require-chart` for data-backed tasks and `--require-media` for image tasks, matching the task brief. It also requires `artifact-summary.json` to already exist next to the artifact.
