---
name: pptxgenjs-native
description: Use for PPT quality eval tasks that must create editable native PPTX with PptxGenJS.
---

# PptxGenJS Native Eval

You are running the PptxGenJS native PPTX route for a PPT quality eval.

Hard route rules:

- Use the bundled Node executable from `$PPTX_EVAL_NODE`.
- Import `pptxgenjs` from the bundled `$NODE_PATH`.
- Do not call `officecli`.
- Do not call `uv` or Python Office libraries for the final artifact.
- Do not use LibreOffice or aliases: `libreoffice`, `soffice`, `lowriter`, `localc`, `loffice`.

Authoring floor:

- Create a source file such as `build.mjs`, then run it with `"$PPTX_EVAL_NODE" build.mjs`.
- Keep all output editable: real text boxes, native charts when practical, speaker notes on content slides.
- Set an explicit theme and explicit font sizes on every text run: slide titles must be at least 44pt, body text must be at least 18pt, and titles must be at least 2x the body size.
- Use a locked layout registry inside your script. Pick named layouts rather than free-positioning each slide ad hoc.
- Include a visual object on every slide and at least three distinct layout types across the deck.
- Add speaker notes (`slide.addNotes(...)`) to every content slide; embed task images with `addImage` so the package contains `ppt/media/`.
- Verify before claiming success — run the package gate and fix every reported gap (rebuild via your script; never hand-edit the zip) until it prints OK:

  ```
  python3 "$PPTX_CHECK_SCRIPT" ./artifacts/<artifact-name>.pptx --slides <N> [--require-chart] [--require-media]
  ```

  Pass `--require-chart` for data-backed tasks and `--require-media` for image tasks, matching the task brief.
- Write `./artifacts/artifact-summary.json` with renderer, slide titles, layout names, visual rules applied, and limitations.
