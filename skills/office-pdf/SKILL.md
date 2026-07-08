---
name: office-pdf
description: "PREVIEW / dark-launched. PDF generation (author HTML, then print to PDF with PawWork's bundled Chromium) and PDF parsing (uv + pdfplumber / pypdf). NOT a default route — only use office-pdf when the user (or an experiment) explicitly asks for the preview PDF route by name. Hard rule: never use PyMuPDF / fitz (AGPL)."
---

# office-pdf — generate and parse PDF (preview)

Two independent paths: **generate** a PDF from HTML using PawWork's bundled Chromium, and **parse** an existing PDF with permissively-licensed Python libraries.

This is a **dark-launched preview**. It does not replace any default route. Only run it when explicitly routed here.

> Known limitation of this dark launch: preview status is enforced only by this skill's description — there is no hard runtime switch yet, and the skill is visible in the Skills page. The hard on/off switch lands with the routing change (PR 4).

## License hard rule (non-negotiable)

**Never use PyMuPDF / `fitz` / `pymupdf` — it is AGPL and must not enter the product.** Also avoid any tool that shells out to it. Allowed parsers are `pdfplumber` (MIT) and `pypdf` (BSD) only. For rendering, use the bundled Chromium — not `wkhtmltopdf`, not LibreOffice, not a system-installed browser.

## Runtime contract

- `uv` must be on `PATH` for the **parse** path. Parsing runs through `uv run`; the runtime injects the package-mirror environment variables so `uv` resolves `pdfplumber` / `pypdf` from the internal mirror. You do not configure the mirror.
- **If `uv` is missing** (parse path), stop and report exactly: `office-pdf parsing requires 'uv' on PATH, but 'uv --version' failed. This is an environment problem — uv should be provisioned by the PawWork runtime. Do not fall back to system pip; report the missing uv instead.`
- The skill directory ships read-only inside the app bundle. **Never write into it.** Work in a fresh directory.

## Path 1 — Generate (HTML → Chromium printToPDF)

PawWork bundles its own Chromium; the PDF is produced by that engine's `Page.printToPDF` (Chrome DevTools Protocol) driving your HTML. No external browser install, no wkhtmltopdf, no LibreOffice.

Author a **self-contained HTML file** built for print:

- Set page geometry with `@page { size: A4; margin: 18mm; }` (or `Letter`, or an explicit `size: 210mm 297mm`).
- Inline all CSS and, where practical, images (as `data:` URIs) so the page renders without network fetches.
- Use `page-break-before/after` / `break-inside: avoid` to control pagination; design against print CSS, not screen scroll.
- Prefer real text and CSS/SVG vector graphics over rasterized screenshots so the PDF stays selectable and crisp.

Then render it to PDF through the runtime's bundled-Chromium print entry point (`Page.printToPDF` over the browser bridge). **If the current build exposes no PDF/print tool, report that the generation path is not available in this runtime rather than shelling out to an unbundled browser or an AGPL library** — this is expected while the route is dark-launched.

## Path 2 — Parse (uv + pdfplumber / pypdf)

`SKILL_DIR` is the skill's base directory **as a plain filesystem path** — copy the line labeled "Base directory as a plain filesystem path" from the skill-load output. Do **not** use the `file://` URL form; if only a `file://` URL is available, strip the `file://` prefix first.

```bash
SKILL_DIR="<plain filesystem path from the skill-load output, no file:// prefix>"
uv --version || { echo "office-pdf parsing requires 'uv' on PATH (see Runtime contract)"; exit 1; }
mkdir -p work && cp "$SKILL_DIR/pyproject.toml" work/pyproject.toml   # pdfplumber (MIT) + pypdf (BSD)
```

The shipped `pyproject.toml` pins both parsers so either import resolves offline, but you only need **one** per task — choose by need, both run from `work/`:

- **`pdfplumber`** — layout-aware text and **table** extraction; use when you need columns, tables, or word positions.
  ```bash
  uv run python -c "import pdfplumber,sys; \
  [print(p.extract_text() or '') for p in pdfplumber.open(sys.argv[1]).pages]" input.pdf
  ```
- **`pypdf`** — fast plain-text, metadata, page count, and split/merge; use for quick text or manipulation.
  ```bash
  uv run python -c "from pypdf import PdfReader; import sys; r=PdfReader(sys.argv[1]); \
  print(len(r.pages), 'pages'); print(r.pages[0].extract_text())" input.pdf
  ```

If text extraction returns empty, the PDF is likely scanned images — say so and stop; do not reach for PyMuPDF or any AGPL OCR-render path.
