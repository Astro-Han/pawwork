# Vendored: svg_to_pptx (SVG -> native PPTX converter)

## Source

- Upstream repo: https://github.com/hugohe3/ppt-master (MIT License, see `LICENSE`)
- Tag: `v3.1.0`
- Commit SHA: `b8808a3a17377ea4e7fd79bdad096bab613f86b9`
- Tag published: 2026-07-04
- Vendored on: 2026-07-08
- Total vendored size: ~600K (all pure Python; no data files, fonts, or examples)

## What was taken

From `skills/ppt-master/scripts/` in the upstream tag:

- `svg_to_pptx/` — the whole converter package (`drawingml/`, `pptx_package/`, `native_objects/`, plus `paths`/`styles`/`utils`/`tspan_flattener`/`use_expander`/`animation_config`). This is the SVG -> DrawingML slide XML engine, the PPTX package assembler (built on `python-pptx`), and the native chart/table object generators.
- `svg_to_pptx.py` — the thin CLI entry that puts the scripts dir on `sys.path` and calls `svg_to_pptx.main()`.
- `console_encoding.py` — UTF-8 stdio helper imported by the package entry and by `flatten_tspan`.
- `resource_paths.py` — SVG image/icon path resolver imported (non-optionally) by `drawingml/converter.py` and `drawingml/elements.py`.
- `svg_finalize/__init__.py` + `svg_finalize/flatten_tspan.py` — only these two files. `converter.py` calls `flatten_positional_tspans()` unconditionally, which delegates to `svg_finalize.flatten_tspan.flatten_text_with_tspans`. `svg_finalize/__init__.py` has no imports, so pulling only `flatten_tspan` in is safe and keeps positional-`<tspan>` flattening working. `flatten_tspan.py` needs only stdlib + `console_encoding`.
- `LICENSE` — upstream MIT license.

## What was intentionally omitted

- Upstream sibling tools unrelated to SVG->PPTX: `image_gen`, `image_search`, TTS/narration external tooling, the Flask `svg_editor`, `project_manager`, `visual_review` (needs their Flask server), `pptx_to_svg`, `svg_position_calculator.py`, `extract_svg_assets.py`, `finalize_svg.py`, plus `examples/`, `docs/`, `projects/`.
- `svg_quality_checker.py` (96KB) — omitted. It is >100KB and is wired into their project/config shell, not a clean standalone import.
- `config.py`, `project_utils.py` — omitted. `svg_to_pptx/pptx_package/dimensions.py` already ships a `try/except ImportError` fallback that defaults to `CANVAS_FORMATS = {ppt169: 1280x720}` and a stub `get_project_info`, so the converter runs without them.
- `pptx_animations.py` — omitted. Imported only inside `try/except ImportError` in `animation_config.py`, `builder.py`, and `slide_xml.py`; absence just disables slide-transition/entrance animations (the eval does not need them).
- Rest of `svg_finalize/` (`embed_icons`, `embed_images`, `crop_images`, `align_embed_images`, `fix_image_aspect`, `svg_rect_to_path`) — omitted. `use_expander.py` imports `svg_finalize.embed_icons` lazily, but only when an `icons/` directory exists (`converter.py` guards the call with `if icons_dir.exists()`); we ship no icon dir, so that path is dead.

## Patches to vendored code

None. No source files were modified. The vendoring works patch-free because of how the upstream already guards its optional dependencies:

- `pptx_animations`, `openpyxl`, and `PIL` are all imported inside `try/except ImportError` (or lazy in-function imports) with graceful fallbacks — so omitting them needs no patch. Without `openpyxl`, `native_objects/workbook.py` uses a pure-Python `zipfile` xlsx writer. Without `PIL`, image embedding falls back to writing the original image bytes (no re-encoding/optimization).
- `cairosvg` / `svglib` / `reportlab` are only reached by `pptx_package/media.py` for the PNG-fallback (compat-mode) render path. Running the CLI with `--no-compat` never imports them, so no patch and no PNG-render dependency.
- `svg_finalize.flatten_tspan` is the one unconditional external import; it is satisfied by vendoring that single module rather than patching the call out.

## Runtime dependency

Only `python-pptx` (see `./pyproject.toml` in this skill, pinned `python-pptx==1.0.2`, Python >= 3.10). `XlsxWriter`/`openpyxl`/`cairosvg`/`Pillow` are all optional and deliberately not included.

## CLI contract

```
uv run python <this-dir>/scripts/svg_to_pptx.py <project_dir> --only native --no-compat --native-objects -o <output.pptx>
```

- `<project_dir>/svg_output/*.svg` — one SVG per slide, converted in sorted filename order. Canvas `viewBox="0 0 1280 720"`.
- `<project_dir>/notes/<stem>.md` — speaker notes matched to `<stem>.svg` by filename (or `slideNN.md` by index).
- `<image href="...">` resolved relative to `svg_output/`, the project root, `<project>/images/`, or `<project>/templates/`; `data:` URIs also embed.
- `--only native` skips the legacy SVG-image pptx; `--no-compat` skips PNG fallback (avoids cairosvg); `--native-objects` turns `data-pptx-native` chart/table `<g>` markers into real chart XML.

## Font size factor

`FONT_PX_TO_HUNDREDTHS_PT = 75` (`drawingml/utils.py`): exported `sz` centipoints = `round(px * 75 / 10) * 10`. So a 44pt title (>= 4400 centipoints) needs SVG `font-size` >= 59 px (use 60 for margin); 18pt body needs >= 24 px; the eval hard floor of 36pt (3600) needs >= 48 px.

## Local end-to-end proof (no LLM, no LibreOffice)

Hand-authored a 3-slide deck (`/tmp/svgtest`) and converted with the command above. Unzip verification of the output:

- `[Content_Types].xml` + `ppt/presentation.xml`: present
- slides: 3 (`slide1..3.xml`)
- `ppt/notesSlides/`: 2 (slides 2, 3)
- `ppt/charts/chart*.xml`: 1 (`chart201.xml`, from a `data-pptx-native="chart"` column marker) + `ppt/embeddings/Microsoft_Excel_Sheet201.xlsx`
- `ppt/media/`: 1 (embedded PNG via `<image xlink:href="pic.png">`)
- explicit run font sizes: 12; max `sz` = 4500 (title 60px), min `sz` = 1650
- out-of-bounds shapes (eval bounds check): 0
- `python-pptx` re-opens the file cleanly; no `soffice`/`libreoffice` used
