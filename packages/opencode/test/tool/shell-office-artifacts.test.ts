import { describe, expect, test } from "bun:test"
import {
  hasOfficeGenerator,
  isDiscoverableOfficeOutput,
  isOfficeOutputPath,
  nonOfficeGeneratorText,
  officeOutputPaths,
} from "../../src/tool/shell-office-artifacts"

describe("isOfficeOutputPath", () => {
  test.each([".docx", ".xlsx", ".pptx", ".pdf"])("treats %s as an office output", (ext) => {
    expect(isOfficeOutputPath(`report${ext}`)).toBe(true)
  })

  test.each(["notes.txt", "data.csv", "image.png", "archive.zip", "noext"])(
    "rejects non-office %s",
    (file) => {
      expect(isOfficeOutputPath(file)).toBe(false)
    },
  )
})

describe("isDiscoverableOfficeOutput", () => {
  // The cwd backstop scan must NOT count .pdf: PDF generation is not wired yet, and
  // ambient PDFs would exhaust the capture budget and drop real docx/xlsx/pptx.
  test.each([".docx", ".xlsx", ".pptx"])("discovers generated %s", (ext) => {
    expect(isDiscoverableOfficeOutput(`out${ext}`)).toBe(true)
  })

  test("does not discover .pdf (still an office output for -o / binary reads)", () => {
    expect(isDiscoverableOfficeOutput("scan.pdf")).toBe(false)
    expect(isOfficeOutputPath("scan.pdf")).toBe(true)
  })
})

describe("officeOutputPaths", () => {
  test.each([
    ["uv run python build.py -o report.docx", ["report.docx"]],
    ['uv run python build.py -o "Quarterly Report.docx"', ["Quarterly Report.docx"]],
    ["uv run python build.py -o 'Q1 deck.pptx'", ["Q1 deck.pptx"]],
    ["uv run python scripts/svg_to_pptx.py deck -o artifacts/deck.pptx", ["artifacts/deck.pptx"]],
    ["python build_xlsx.py data.csv --out book.xlsx", ["book.xlsx"]],
    ["python gen.py --output=slides.pdf", ["slides.pdf"]],
    // python .save(...) — the documented python-docx / openpyxl / python-pptx call
    [`uv run python -c "from docx import Document; Document().save('out.docx')"`, ["out.docx"]],
    [`python -c "wb.save(\\"book.xlsx\\")"`, ["book.xlsx"]],
    ["uv run python <<'PY'\nprs.save('deck.pptx')\nPY", ["deck.pptx"]],
  ])("parses the output path from %s", (command, expected) => {
    expect(officeOutputPaths(command)).toEqual(expected)
  })

  test.each([
    "grep -o report.docx README.md", // grep's -o is "only matching", not an output file
    'echo "usage: -o report.docx"', // office text lives inside a quoted literal
    'uv run python build.py -o "$OUT.docx"', // dynamic shell value, discovery must find the real file
    "uv run python build.py --out report-*.docx", // glob value, discovery must find the real file
    'uv run python build.py --out "{draft,final}.docx"', // brace expansion is shell state, not a literal file
    'uv run python build.py --out "[ab].docx"', // bracket glob is shell state, not a literal file
    "uv run python build.py --out ~/report.docx", // tilde expansion is shell state, not a literal file
    "cd reports && uv run python build.py -o report.docx", // relative to a changed cwd, discovery must find it
    `cd reports && uv run python -c "from docx import Document; Document().save('report.docx')"`,
    `uv run python build.py && node -e "wb.save('phantom.docx')"`,
    "uv run python read_docx.py input.docx", // office file is an input, no output flag
    "cat report.docx",
    "uv run pytest",
    `echo "x.save('a.docx')"`, // .save text inside a non-generator command
    // .save inside an echo literal, even when a real generator runs later in the chain
    `echo "wb.save('phantom.xlsx')" && uv run python real.py`,
  ])("returns no output path for non-generator / read command %s", (command) => {
    expect(officeOutputPaths(command)).toEqual([])
  })

  test("still parses absolute outputs after a cwd-changing segment", () => {
    expect(officeOutputPaths("cd reports && uv run python build.py -o /tmp/report.docx")).toEqual([
      "/tmp/report.docx",
    ])
  })
})

describe("hasOfficeGenerator", () => {
  test("detects native python office generators", () => {
    expect(hasOfficeGenerator("uv run python build.py")).toBe(true)
    expect(hasOfficeGenerator("python -c \"from docx import Document\"")).toBe(true)
  })

  test("ignores non-generator commands", () => {
    expect(hasOfficeGenerator("grep -o report.docx README.md")).toBe(false)
    expect(hasOfficeGenerator("cat report.docx")).toBe(false)
  })
})

describe("nonOfficeGeneratorText", () => {
  test("strips pure office generators", () => {
    expect(nonOfficeGeneratorText("uv run python build.py -o report.docx")).toBe("")
  })

  test("leaves chained non-office side effects", () => {
    expect(nonOfficeGeneratorText("uv run python build.py -o report.docx && echo notes > notes.txt")).toBe(
      "echo notes > notes.txt",
    )
  })
})
