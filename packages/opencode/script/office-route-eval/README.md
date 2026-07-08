# Office Route Eval Baseline

Local baseline for issue #1273. It compares the current OfficeCLI route with a
Python + uv + skills route across three real office tasks:

- `xlsx-dashboard`: CSV to Excel dashboard.
- `docx-board-memo`: notes to Word board memo.
- `pptx-pitch-deck`: brief to pitch deck.

The judge never uses LibreOffice. It inspects OOXML zip contents, the raw
opencode JSON event stream, command audit logs, artifact hashes, and route
metadata.

## Routes

`officecli` means the current PawWork OfficeCLI skill route. The route must call
`officecli` for the delivered Office artifact. Lightweight preprocessing is
allowed only when it does not create the final `.xlsx`, `.docx`, or `.pptx`
through Python Office libraries.

`python` means Python + uv + local route skill. It must call `uv` and must not
call `officecli`.

Both routes fail if they call `libreoffice`, `soffice`, `lowriter`, `localc`, or
`loffice`.

## Run

From `packages/opencode`:

```bash
bun run office:eval calibrate --model openai/gpt-5.4-mini --variant low
bun run office:eval full --model openai/gpt-5.4-mini --variant low --rounds 3
bun run office:eval report
```

`calibrate` runs `3 tasks x 2 routes x 1 round`. `full` runs all tasks and both
routes for the requested rounds. Output lands in `script/office-route-eval/runs/`
and is ignored by git.

Each run contains:

- `prompt.md`
- `events.jsonl`
- `stderr.log`
- `run-summary.json`
- `judge.json`
- `artifacts/`

## Replacement Bar

This eval pack is enough to open a formal replacement PR only if the Python
route passes all three task families in at least two of three rounds, has zero
route-policy failures, and does not need more repair steps than the OfficeCLI
route on the same tasks.
