---
name: office-pptx
description: "Native .pptx generation by authoring one SVG per slide and converting with the bundled offline svg_to_pptx tool — every shape stays natively editable in PowerPoint / Keynote / WPS. Use this for any presentation, pitch deck, slides, or .pptx request."
---

# office-pptx — native PPTX from SVG

You build an editable native `.pptx` by hand-authoring one SVG per slide and converting the deck with the bundled, offline `svg_to_pptx` converter. No LibreOffice, no LLM-rendered image slides — every shape stays natively editable in PowerPoint / Keynote / WPS.

This is a **dark-launched preview**. It does not replace the default office path. Only run it when explicitly routed here.

> Known limitation of this dark launch: preview status is enforced only by this skill's description (the model is told not to pick it by default) — there is no hard runtime switch yet, and the skill is visible in the Skills page. The hard on/off switch lands with the routing change (PR 4).

## Runtime contract

- `uv` must be on `PATH`. This skill runs all Python through `uv run`; the runtime injects the package-mirror environment variables so `uv` resolves `python-pptx` from the internal mirror. You do not configure the mirror yourself.
- **If `uv` is missing**, stop and report exactly: `office-pptx requires 'uv' on PATH, but 'uv --version' failed. This is an environment problem — uv should be provisioned by the PawWork runtime. Do not fall back to system pip; report the missing uv instead.` Do not attempt `pip install`, `brew install`, or any other fallback.
- The skill directory ships read-only inside the app bundle. **Never write into it.** Do all work in a fresh working directory (e.g. `./office-pptx-work/`).

Below, `SKILL_DIR` means the skill's base directory **as a plain filesystem path** — copy the line labeled "Base directory as a plain filesystem path" from the skill-load output. Do **not** use the `file://` URL form; if only a `file://` URL is available, strip the `file://` prefix first. Set it once:

```bash
SKILL_DIR="<plain filesystem path from the skill-load output, no file:// prefix>"
uv --version || { echo "office-pptx requires 'uv' on PATH (see Runtime contract)"; exit 1; }
```

## Setup the working project

```bash
mkdir -p work/deck/svg_output work/deck/notes work/artifacts
cp "$SKILL_DIR/pyproject.toml" work/pyproject.toml   # pins python-pptx==1.0.2, Python >=3.10
```

Run every `uv run` command from `work/` (the directory that holds `pyproject.toml`).

## Authoring rules (hard floor — do not relax)

- **Canvas**: every SVG must use `viewBox="0 0 1280 720"` (16:9). Keep all shapes inside that box.
- **One SVG per slide** in `deck/svg_output/`, named with zero-padded order prefixes (`01_title.svg`, `02_chart.svg`, ...); files convert in filename order.
- **Font sizes are SVG px, exported at 0.75pt per px.** Set an explicit `font-size` on every `<text>`: titles at least `60` px (= 45pt), body at least `24` px (= 18pt), and titles at least 2× the body px. Write one `<text>` per visual line, not positional `<tspan>`.
- **SVG `<text>` does not wrap** — a long line renders straight off the slide edge. Budget characters before writing: a Latin line takes about `0.55 × font-size` px per character (CJK about `1.0 × font-size`). Keep `chars × 0.55 × font-size ≤ 1220 − x` for every line. Example: a 60px title starting at `x=80` fits at most ~34 Latin characters. Split or shorten longer lines. (The text-budget gate below enforces this.)
- **Conclusion titles, not topic labels.** Every slide needs a real visual object (native chart, image, or a structured system of 3+ shapes). Vary layout across the deck.
- **Speaker notes**: for each content slide add `deck/notes/<same-stem>.md` (e.g. `02_chart.md` for `02_chart.svg`); its Markdown becomes that slide's notes. Cover at least slides 2..N.
- **Native editable chart** (required whenever the slide presents data): wrap the chart region in
  `<g data-pptx-native="chart" data-pptx-x="80" data-pptx-y="210" data-pptx-width="1120" data-pptx-height="450">` and put the data in a child
  `<metadata type="application/json">{"type":"column","categories":["Q1","Q2"],"series":[{"name":"2025","values":[10,20]}]}</metadata>`.
  Each series `values` length must equal `categories` length. `type` may be `column`, `bar`, `line`, `pie`, `doughnut`, or `area`. Keep a plain fallback shape inside the group. This becomes a real `ppt/charts/chart*.xml` (editable chart), not a picture.
- **Image**: use `<image x=".." y=".." width=".." height=".." xlink:href="pic.png"/>` and place `pic.png` next to the SVGs in `deck/svg_output/`. Base64 `data:` hrefs also work. Images are embedded into `ppt/media/`.

## Gate 1 — text budget (before converting)

Run the budget check and fix every reported line (shorten the copy or split it into more `<text>` lines) until it prints `OK`:

```bash
uv run python "$SKILL_DIR/scripts/check_text_budget.py" deck/svg_output
```

Do not convert while this reports `FAIL`.

## Convert

Run from `work/` (holds `pyproject.toml`):

```bash
uv run python "$SKILL_DIR/scripts/svg_to_pptx.py" deck --only native --no-compat --native-objects -o artifacts/<name>.pptx
```

`--only native` skips the legacy image-based pptx; `--no-compat` skips the PNG fallback (no cairosvg needed); `--native-objects` turns the `data-pptx-native` chart markers into real `ppt/charts/chart*.xml`.

## Gate 2 — package assets (before delivering)

Finish in this order:

1. Write `artifacts/artifact-summary.json`. It must at least contain the keys `renderer` (string) and `slides` (non-empty array, one entry per slide with its title and layout); also record visual rules applied and limitations.
2. Run the package gate as the **last** step and fix every reported gap by rebuilding the deck source — **never hand-edit the zip** — until it prints `OK` (run from `work/`, same as every other command — all Python goes through `uv run`, never a bare `python3`):

```bash
uv run python "$SKILL_DIR/scripts/check_pptx_assets.py" artifacts/<name>.pptx --slides <N> [--require-chart] [--require-media]
```

Pass `--require-chart` for data-backed decks and `--require-media` when the deck must embed an image. The gate also requires `artifact-summary.json` to already exist next to the artifact, and checks the slide count and speaker-note coverage.

**The deck is not done until Gate 1 and Gate 2 both print `OK`.** Machine checks decide completion, not your own judgement.

## Provenance

The `svg_to_pptx` converter under `scripts/` is vendored from an upstream MIT project. See `VENDORED.md` for the exact source (repo, tag, commit) and the omitted/optional-dependency notes, and `LICENSE` for the upstream MIT license. Both must ship with this skill; do not remove them.
