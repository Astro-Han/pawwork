---
name: office-xlsx
description: "Native .xlsx generation and editing with Python openpyxl: real formulas the recipient can recalc, explicit number formats and fonts, native charts. Also reads and parses existing workbooks. Use this for any Excel, spreadsheet, or financial-model request, and for reading or modifying an existing .xlsx."
---

# office-xlsx — native XLSX with openpyxl

You build editable `.xlsx` workbooks with Python `openpyxl`: real formulas the recipient can recalc, explicit number formats and fonts, and native charts. You can also read and parse existing workbooks. No LibreOffice.

## Runtime contract

- `uv` must be on `PATH`. All Python runs through `uv run`; the runtime injects the package-mirror environment variables so `uv` resolves `openpyxl` from the internal mirror. You do not configure the mirror.
- **If `uv` is missing**, stop and report exactly: `office-xlsx requires 'uv' on PATH, but 'uv --version' failed. This is an environment problem — uv should be provisioned by the PawWork runtime. Do not fall back to system pip; report the missing uv instead.` Do not attempt `pip install` or any other fallback.
- The skill directory ships read-only inside the app bundle. **Never write into it.** Work in a fresh directory.

`SKILL_DIR` below means the skill's base directory **as a plain filesystem path** — copy the line labeled "Base directory as a plain filesystem path" from the skill-load output. Do **not** use the `file://` URL form; if only a `file://` URL is available, strip the `file://` prefix first.

```bash
SKILL_DIR="<plain filesystem path from the skill-load output, no file:// prefix>"
uv --version || { echo "office-xlsx requires 'uv' on PATH (see Runtime contract)"; exit 1; }
mkdir -p work && cp "$SKILL_DIR/pyproject.toml" work/pyproject.toml   # pins openpyxl==3.1.5
```

Run every `uv run` command from `work/`.

## Authoring rules (hard floor — do not relax)

- **Real formulas, not baked-in numbers.** When a cell is a computed result (totals, ratios, growth, margins), write the Excel formula string (`ws["B10"] = "=SUM(B2:B9)"`), never the pre-computed value. The recipient must be able to change an input and see downstream cells recalc. The delivery gate fails a data model with zero formula cells when `--require-formula` is set.
- **Formula injection: only YOUR computed cells may be formulas.** Any value that comes from user-supplied data (CSV imports, pasted text, names, notes) and starts with `=`, `+`, `-`, or `@` must be stored as **text**, never as a formula — e.g. a user field `=HYPERLINK("http://evil","x")` would otherwise become a live formula. Force text with `cell.value = raw; cell.data_type = "s"; cell.number_format = "@"`. When you genuinely need a link, use the `cell.hyperlink` attribute, never the `HYPERLINK()` formula. The gate FAILs on formulas calling `HYPERLINK` / `WEBSERVICE` / `IMPORT*` / DDE-style patterns.
- **Explicit number formats.** Set `cell.number_format` for every money / percent / date column (e.g. `"#,##0.00"`, `"0.0%"`, `"yyyy-mm-dd"`). Do not rely on the default `General` format for financial output.
- **Explicit fonts and styles.** Set header rows with an explicit `Font(bold=True, size=...)` and, where it aids reading, `PatternFill` / `Alignment` / `Border`. Do not leave headers visually identical to body rows.
- **Freeze panes and widths.** Freeze the header row (`ws.freeze_panes = "A2"`) and set sensible `column_dimensions[col].width` so columns are not clipped.
- **Charts are native objects.** When the task calls for a chart, build it with `openpyxl.chart` (`BarChart`, `LineChart`, `PieChart`, ...) bound to a `Reference` over the data range — a real chart object, not a pasted image.
- **One concern per sheet.** Split inputs / model / outputs across named sheets rather than cramming everything into `Sheet1`.

Minimal shape:

```python
from openpyxl import Workbook
from openpyxl.styles import Font
wb = Workbook()
ws = wb.active
ws.title = "Model"
ws["A1"] = "Quarter"; ws["B1"] = "Revenue"
ws["A1"].font = ws["B1"].font = Font(bold=True, size=12)
ws["A2"] = "Q1"; ws["B2"] = 100
ws["A3"] = "Q2"; ws["B3"] = 140
ws["A4"] = "Total"; ws["B4"] = "=SUM(B2:B3)"    # real formula
ws["B2"].number_format = ws["B3"].number_format = ws["B4"].number_format = "#,##0"
ws.freeze_panes = "A2"
wb.save("out.xlsx")
```

## Reading / parsing

`load_workbook(path)` reads formulas; `load_workbook(path, data_only=True)` reads the last cached computed values. Use `data_only=True` when you need results, `data_only=False` when you need to inspect or preserve formulas.

## Gate — structure check (before delivering)

Run the structure gate and fix every reported gap by rebuilding from your generator — **never hand-edit the zip** — until it prints `OK`:

```bash
uv run python "$SKILL_DIR/scripts/check_xlsx.py" out.xlsx --min-sheets 1 [--require-formula] [--require-chart]
```

Pass `--require-formula` for any calculation / model task and `--require-chart` when the task calls for a chart. The gate confirms the workbook opens, has populated cells, flags injection-style formulas, and (when required) contains real formula cells and chart parts. Charts are counted from the package's `xl/charts/chart*.xml` parts — a stable OOXML signal — so the gate does not depend on openpyxl's chart read-back.

**The workbook is not done until this gate prints `OK`.** The machine check decides completion, not your own judgement.
