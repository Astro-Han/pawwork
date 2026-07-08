# PPT Quality Eval

Local eval for understanding what makes a high-quality PPT skill. It is separate
from `office-route-eval` because HTML showcase decks and native editable PPTX
decks must not be scored as the same artifact type.

## Routes

- `officecli`: current PawWork OfficeCLI route.
- `python-pptx`: Python + uv + `python-pptx`.
- `pptxgenjs`: bundled Node + PptxGenJS.
- `svg-pptx`: model-authored SVG per slide, converted to native DrawingML PPTX
  by the vendored ppt-master `svg_to_pptx` converter (MIT, pinned version; see
  `route-skills/svg-pptx-native/VENDORED.md`).
- `html-showcase`: single-file HTML deck inspired by locked-layout showcase
  skills such as Guizang. This route is scored separately from native PPTX.

All routes fail if they call LibreOffice or aliases.

## Tasks

- `investor-update`: notes + CSV to a data-backed investor update deck.
- `template-following`: starter `.pptx` to a partner strategy deck that should
  preserve template structure.
- `report-to-deck`: markdown report + image fixture to a decision deck.

## Run

From `packages/opencode`:

```bash
bun run ppt:eval calibrate --model anthropic/claude-haiku-4-5
bun run ppt:eval full --model anthropic/claude-haiku-4-5 --rounds 2
bun run ppt:eval report
```

Weak-model policy (2026-07-08): use Anthropic Sonnet or Haiku as the weak
model, not GPT-5.4 Mini.

Output lands in `script/ppt-quality-eval/runs/` and is ignored by git.

The judge does not use LibreOffice. It inspects OOXML zip contents for native
PPTX and static HTML structure for showcase decks. This proves structure and
editability gates, not exact PowerPoint pixel rendering.
