---
name: office-docx
description: "PREVIEW / dark-launched. Native .docx generation with Python python-docx (real Heading styles, explicit fonts/sizes, tables, page structure), plus reading/parsing existing documents. NOT the default Word path — for a normal Word doc / report / letter / memo request keep using officecli-docx. Only use office-docx when the user (or an experiment) explicitly asks for the python-docx / native-Python preview route by name."
---

# office-docx — native DOCX with python-docx (preview)

You build editable `.docx` documents with Python `python-docx`: real Heading styles that drive the navigation pane and table of contents, explicit fonts and sizes, native tables, and clean paragraph structure. You can also read and parse existing documents. No officecli, no LibreOffice.

This is a **dark-launched preview**. It does not replace the default Word path. Only run it when explicitly routed here.

> Known limitation of this dark launch: preview status is enforced only by this skill's description — there is no hard runtime switch yet, and the skill is visible in the Skills page. The hard on/off switch lands with the routing change (PR 4).

## Runtime contract

- `uv` must be on `PATH`. All Python runs through `uv run`; the runtime injects the package-mirror environment variables so `uv` resolves `python-docx` from the internal mirror. You do not configure the mirror.
- **If `uv` is missing**, stop and report exactly: `office-docx requires 'uv' on PATH, but 'uv --version' failed. This is an environment problem — uv should be provisioned by the PawWork runtime. Do not fall back to system pip or officecli; report the missing uv instead.` Do not attempt `pip install` or any other fallback.
- The skill directory ships read-only inside the app bundle. **Never write into it.** Work in a fresh directory.

`SKILL_DIR` below means the skill's base directory **as a plain filesystem path** — copy the line labeled "Base directory as a plain filesystem path" from the skill-load output. Do **not** use the `file://` URL form; if only a `file://` URL is available, strip the `file://` prefix first.

```bash
SKILL_DIR="<plain filesystem path from the skill-load output, no file:// prefix>"
uv --version >/dev/null 2>&1 || { echo "office-docx requires 'uv' on PATH, but 'uv --version' failed. This is an environment problem — uv should be provisioned by the PawWork runtime. Do not fall back to system pip or officecli; report the missing uv instead."; exit 1; }
mkdir -p work && cp "$SKILL_DIR/pyproject.toml" work/pyproject.toml   # pins python-docx==1.1.2
```

Run every `uv run` command from `work/`.

## Authoring rules (hard floor — do not relax)

- **Real Heading styles, not bold body text.** Use `doc.add_heading("...", level=1)` (or `paragraph.style = "Heading 2"`) for every section title. This is what drives the navigation pane, outline, and any table of contents. Never fake a heading with large bold body text — the delivery gate fails a document that needs headings but has none.
- **Explicit fonts and sizes.** Set body and heading fonts deliberately (`run.font.name`, `run.font.size = Pt(11)`, `run.font.bold`). Do not leave the whole document on the theme default when the task specifies a look.
- **Native tables.** When presenting structured data, use `doc.add_table(rows, cols)` with an explicit table style and a bold header row — a real Word table, not tab-aligned text.
- **Document structure.** Use a title, then Heading 1 / Heading 2 sections, real bullet / numbered lists (`style="List Bullet"` / `"List Number"`), and page breaks where the layout needs them.

Minimal shape:

```python
from docx import Document
from docx.shared import Pt
doc = Document()
doc.add_heading("Quarterly Review", level=0)      # title
doc.add_heading("Summary", level=1)               # real Heading 1
p = doc.add_paragraph()
run = p.add_run("Revenue grew 40% quarter over quarter.")
run.font.size = Pt(11)
t = doc.add_table(rows=1, cols=2); t.style = "Light Grid Accent 1"
hdr = t.rows[0].cells
hdr[0].text = "Quarter"; hdr[1].text = "Revenue"
doc.save("out.docx")
```

## Reading / parsing

`Document(path)` opens an existing file: iterate `doc.paragraphs` (each `p.text`, `p.style.name`) and `doc.tables` (each `table.rows[i].cells[j].text`) to extract or edit content.

## Gate — structure check (before delivering)

Run the structure gate and fix every reported gap by rebuilding from your generator — **never hand-edit the zip** — until it prints `OK`:

```bash
uv run python "$SKILL_DIR/scripts/check_docx.py" out.docx --min-paragraphs 1 [--require-heading] [--require-table]
```

Pass `--require-heading` for any structured report / multi-section document and `--require-table` when the task calls for a table. The gate confirms the document opens, has real body paragraphs, and (when required) uses real Heading styles and contains tables.

**The document is not done until this gate prints `OK`.** The machine check decides completion, not your own judgement.
