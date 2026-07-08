---
name: svg-pptx-native
description: Use for PPT quality eval tasks that build editable native PPTX by authoring one SVG per slide and converting with the bundled svg_to_pptx tool.
---

# SVG to PPTX Native Eval

You are running the SVG-to-PPTX native route for a PPT quality eval. You hand-author one SVG per slide, then convert the deck into an editable native `.pptx` with the bundled `svg_to_pptx` converter (no LLM, no LibreOffice).

Hard route rules:

- Use `uv run python "$SVG_PPTX_SCRIPT"` to convert. Use the provided `pyproject.toml` in the working directory.
- Do not call `officecli`, `node`, or PptxGenJS for the final artifact.
- Do not use LibreOffice or aliases: `libreoffice`, `soffice`, `lowriter`, `localc`, `loffice`.

Authoring floor:

- Canvas: every SVG must use `viewBox="0 0 1280 720"` (16:9). Keep all shapes inside that box.
- Lay the deck out as a project directory: put one SVG per slide in `<project>/svg_output/`, named with zero-padded order prefixes (`01_title.svg`, `02_chart.svg`, ...); files convert in filename order.
- Font sizes are SVG px and export at 0.75pt per px. Set an explicit `font-size` on every `<text>`: titles at least `60` px (44pt), body at least `24` px (18pt), and titles at least 2x the body px. Write one `<text>` per visual line rather than positional `<tspan>`.
- SVG `<text>` does not wrap; long lines render straight off the slide edge. Budget characters before writing: a Latin line takes about `0.55 * font-size` px per character (CJK about `1.0 * font-size`). Keep `chars * 0.55 * font-size <= 1220 - x` for every line. Example: a 60px title starting at x=80 fits at most ~34 characters. Split longer lines into multiple `<text>` elements or shorten the copy.
- Use conclusion titles, not topic labels. Include a real visual object on every slide (native chart, image, or a structured shape system of 3+ shapes), and vary the layout across the deck.
- Speaker notes: for each content slide add `<project>/notes/<same-stem>.md` (e.g. `02_chart.md` for `02_chart.svg`); its Markdown becomes the slide's notes. Cover at least slides 2..N.
- Native editable chart (required for data tasks): wrap the chart region in
  `<g data-pptx-native="chart" data-pptx-x="80" data-pptx-y="210" data-pptx-width="1120" data-pptx-height="450">` and put the data in a child
  `<metadata type="application/json">{"type":"column","categories":["Q1","Q2"],"series":[{"name":"2025","values":[10,20]}]}</metadata>`.
  Each series `values` length must equal `categories` length. `type` may be `column`, `bar`, `line`, `pie`, `doughnut`, or `area`. Keep a plain fallback shape inside the group.
- Image (required for image tasks): use `<image x=".." y=".." width=".." height=".." xlink:href="pic.png"/>` and place `pic.png` next to the SVGs in `svg_output/`. Base64 `data:` hrefs also work.

Before converting, run the text budget check and fix every reported line (shorten the copy or split it into more `<text>` lines) until it prints OK:

```
uv run python "$(dirname "$SVG_PPTX_SCRIPT")/check_text_budget.py" ./deck/svg_output
```

Conversion command (run from the working directory that holds `pyproject.toml`):

```
uv run python "$SVG_PPTX_SCRIPT" ./deck --only native --no-compat --native-objects -o ./artifacts/<artifact-name>.pptx
```

`--no-compat` skips the PNG fallback (no cairosvg needed); `--native-objects` turns the chart markers into real `ppt/charts/chart*.xml`.

Finish in this order: (1) write `./artifacts/artifact-summary.json` with renderer, slide titles, layout names, visual rules applied, and limitations; (2) run the package gate as the LAST step and fix every reported gap (rebuild the deck source; never hand-edit the zip) until it prints OK:

```
python3 "$PPTX_CHECK_SCRIPT" ./artifacts/<artifact-name>.pptx --slides <N> [--require-chart] [--require-media]
```

Pass `--require-chart` for data-backed tasks and `--require-media` for image tasks, matching the task brief. It also requires `artifact-summary.json` to already exist next to the artifact. Also confirm the title run's `<a:rPr sz="...">` is >= 4400.
