# PPT Quality Eval

Local eval for understanding what makes a high-quality PPT skill. It is separate
from `office-route-eval` because HTML showcase decks and native editable PPTX
decks must not be scored as the same artifact type.

## Routes

- `officecli`: current PawWork OfficeCLI route.
- `python-pptx`: Python + uv + `python-pptx`.
- `pptxgenjs`: bundled Node + PptxGenJS.
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
bun run ppt:eval calibrate --model openai/gpt-5.4-mini --variant medium
bun run ppt:eval full --model openai/gpt-5.4-mini --variant medium --rounds 2
bun run ppt:eval report
```

Output lands in `script/ppt-quality-eval/runs/` and is ignored by git.

The judge does not use LibreOffice. It inspects OOXML zip contents for native
PPTX and static HTML structure for showcase decks. This proves structure and
editability gates, not exact PowerPoint pixel rendering.
