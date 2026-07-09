import { describe, expect, test } from "bun:test"
import {
  hasOfficeOutputIntent,
  isDiscoverableOfficeOutput,
  isOfficeOutputPath,
  nonOfficeGeneratorText,
  officeOutputPaths,
} from "../../src/tool/shell-office-artifacts"
import { isLikelyWriteCommand } from "../../src/tool/shell-write-heuristic"

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
    // uv permits global options before the `run` subcommand; an ABSOLUTE output is still
    // captured exactly even when `--directory` changes the cwd
    ["uv --directory work run python build.py -o /tmp/report.docx", ["/tmp/report.docx"]],
    // --project only affects project discovery (no chdir), so a relative output is exact
    ["uv --project app run python3 build.py --out book.xlsx", ["book.xlsx"]],
    // a non-directory global option (--offline) still recognizes the generator + exact output
    ["uv --offline run python build.py -o report.docx", ["report.docx"]],
    // a `--directory` AFTER the python command is the script's own arg, not uv's chdir → exact
    ["uv run python build.py --directory sub -o report.docx", ["report.docx"]],
    ["python build_xlsx.py data.csv --out book.xlsx", ["book.xlsx"]],
    ["python gen.py --output=slides.pdf", ["slides.pdf"]],
    // a versioned python interpreter (`python3.12`) is a generator too, matching
    // isPythonCommandToken's `/^python\d/` — else the output is silently lost
    ["python3.12 build.py -o report.docx", ["report.docx"]],
    // python .save(...) — the documented python-docx / openpyxl / python-pptx call
    [`uv run python -c "from docx import Document; Document().save('out.docx')"`, ["out.docx"]],
    [`python -c "wb.save(\\"book.xlsx\\")"`, ["book.xlsx"]],
    ["uv run python <<'PY'\nprs.save('deck.pptx')\nPY", ["deck.pptx"]],
    // python raw / f-string prefixes on the .save() argument
    [`uv run python -c "doc.save(r'out.docx')"`, ["out.docx"]],
    [`uv run python -c "doc.save(f'report.docx')"`, ["report.docx"]],
    // whitespace before the call paren
    [`uv run python -c "doc.save ('spaced.docx')"`, ["spaced.docx"]],
    // Windows absolute path with backslash separators — the capture must not truncate at `C:`
    [String.raw`uv run python -c "doc.save(r'C:\logs\report.docx')"`, [String.raw`C:\logs\report.docx`]],
    // a shell line continuation (backslash-newline) is one command, not two segments
    ["uv run python build.py \\\n-o report.docx", ["report.docx"]],
    // uv --directory is scoped to its own command: the absolute a.docx is captured, and the
    // second command's relative b.docx (parent cwd restored after `&&`) is captured exactly
    [
      "uv --directory work run python a.py -o /tmp/a.docx && uv run python b.py -o b.docx",
      ["/tmp/a.docx", "b.docx"],
    ],
    // a NEWLINE separates two independent commands too (not just a heredoc body), so the
    // --directory chdir must not leak to the second command's relative b.docx
    [
      "uv --directory work run python a.py -o /tmp/a.docx\nuv run python b.py -o b.docx",
      ["/tmp/a.docx", "b.docx"],
    ],
    // a --directory VALUE that collides with a uv subcommand name (`build`) must be skipped,
    // not read as the subcommand — the real `run` still makes this a generator (absolute
    // output stays exact)
    ["uv --directory build run python make.py -o /tmp/report.docx", ["/tmp/report.docx"]],
    ["uv --python python3 run python make.py -o /tmp/report.docx", ["/tmp/report.docx"]],
    // a literal `%` in a filename is not a Windows variable — the static name is captured
    ["uv run python build.py -o '/tmp/Growth 20%.pptx'", ["/tmp/Growth 20%.pptx"]],
    ["uv run python build.py -o 100%.docx", ["100%.docx"]],
  ])("parses the output path from %s", (command, expected) => {
    expect(officeOutputPaths(command)).toEqual(expected)
  })

  test.each([
    "grep -o report.docx README.md", // grep's -o is "only matching", not an output file
    'echo "usage: -o report.docx"', // office text lives inside a quoted literal
    'uv run python build.py -o "$OUT.docx"', // dynamic shell value, discovery must find the real file
    'uv run python build.py -o "%OUT%.docx"', // Windows cmd variable, discovery must find the real file
    "uv run python build.py --out report-*.docx", // glob value, discovery must find the real file
    "uv --directory work run python build.py -o report.docx", // relative under --directory (global) chdir
    "uv run --directory work python build.py -o report.docx", // relative under --directory (run option) chdir
    "uv run --python python3 --directory work python build.py -o report.docx", // --python value must not hide --directory
    "uv run -p python3 --directory work python build.py -o report.docx", // short -p form too
    "uv --directory work run python <<'PY'\ndoc.save('out.docx')\nPY", // heredoc .save under --directory chdir
    'uv run python build.py --out "{draft,final}.docx"', // brace expansion is shell state, not a literal file
    'uv run python build.py --out "[ab].docx"', // bracket glob is shell state, not a literal file
    "uv run python build.py --out ~/report.docx", // tilde expansion is shell state, not a literal file
    "cd reports && uv run python build.py -o report.docx", // relative to a changed cwd, discovery must find it
    `cd reports && uv run python -c "from docx import Document; Document().save('report.docx')"`,
    `uv run python build.py && node -e "wb.save('phantom.docx')"`,
    "uv run python read_docx.py input.docx", // office file is an input, no output flag
    "cat report.docx",
    "uv run pytest",
    "uv pip install run -o report.docx", // `run` is an install arg, not the uv subcommand
    "uv tool run ruff -o report.docx", // a different uv subcommand, not `uv run`
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

describe("hasOfficeOutputIntent", () => {
  // A generator that named an office output the parser couldn't pin to an exact path
  // (dynamic / glob / cwd-relative-after-cd) still shows intent → the cwd backstop must
  // scan for the real file.
  test.each([
    'uv run python build.py -o "$OUT.docx"', // dynamic POSIX variable
    'uv run python build.py -o "%OUT%.docx"', // dynamic Windows cmd variable
    'uv run python build.py -o "$OUT"', // whole filename in a variable — extension hidden
    "uv run python build.py --out report-*.docx", // glob
    "cd reports && uv run python build.py -o report.docx", // relative after cd
    `cd reports && uv run python -c "from docx import Document; Document().save('report.docx')"`,
    // mixed: an exact output AND a dynamic one — intent still fires for the dynamic part
    // (so the cwd scan runs) even though the exact `a.docx` is captured precisely
    'uv run python a.py -o a.docx && OUT=b uv run python b.py -o "$OUT.docx"',
    // uv global options before `run` must not hide the dynamic output
    'uv --directory work run python build.py -o "$OUT.docx"',
    // a RELATIVE output under `uv --directory` chdir is unresolved → intent → cwd scan
    "uv --directory work run python build.py -o report.docx",
    "uv run --directory work python build.py -o report.docx", // --directory as a `uv run` option also chdirs
    "uv --directory work run python <<'PY'\ndoc.save('out.docx')\nPY", // heredoc .save inherits the --directory chdir
    "uv run --python python3 --directory work python build.py -o report.docx", // --python value collision must still see --directory
    // a --directory value that collides with a uv subcommand name (`build`) must not hide the
    // real `run`; the relative output under that chdir is still unresolved intent
    "uv --directory build run python make.py -o report.docx",
    // a STATIC .pdf under a changed cwd can't be exactly captured (cwd) and can't be
    // discovered (.pdf excluded) — it must still be intent so the turn is flagged uncaptured
    "cd reports && uv run python gen.py -o report.pdf",
    "uv --directory reports run python gen.py -o report.pdf",
  ])("detects office-output intent in %s", (command) => {
    expect(hasOfficeOutputIntent(command)).toBe(true)
  })

  // A bare generator that names NO output, or a read-only invocation, has no intent —
  // so the backstop never speculatively scans (and never false-flags) it.
  test.each([
    "uv run python build.py", // bare script; internal save relies on expected_outputs
    "uv run pytest",
    "uv run python read_docx.py input.docx", // office file is an INPUT, no output flag
    "grep -o report.docx README.md", // not a generator
    "cat report.docx",
    "uv run python build.py --out report.txt", // output flag, but non-office target
    'uv run python build.py -o "$OUT.pdf"', // dynamic .pdf — discovery can't find it
    "uv run python build.py -o report.docx", // exact static output — captured, not scanned
    "uv --offline run python build.py -o report.docx", // exact under a non-directory global opt
    "uv --offline run pytest", // read-only under a global opt — same as bare `uv run pytest`
    "uv --project app run python build.py -o report.docx", // --project does not chdir → exact
    // uv --directory is scoped: after `&&` the parent cwd is restored, so the second
    // command's relative b.docx is exactly captured, not an unresolved intent
    "uv --directory work run python a.py -o /tmp/a.docx && uv run python b.py -o b.docx",
    "uv pip install run -o report.docx", // `run` is an install arg, not the uv subcommand
  ])("reports no intent for %s", (command) => {
    expect(hasOfficeOutputIntent(command)).toBe(false)
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

  test("drops an office-output generator but keeps its own write-redirection", () => {
    // the office command is dropped, but its `> log.txt` side effect survives
    expect(nonOfficeGeneratorText("uv run python build.py -o report.docx > log.txt")).toBe("> log.txt")
  })

  test("keeps a python segment that named no office output (a real non-office write)", () => {
    // setup.py build / a redirected analyze script are real writes, NOT office outputs —
    // they must stay intact so the write heuristic still sees them
    expect(nonOfficeGeneratorText("python setup.py build")).toBe("python setup.py build")
    expect(nonOfficeGeneratorText("uv run python analyze.py > results.txt")).toBe(
      "uv run python analyze.py > results.txt",
    )
  })

  test("does not mistake a redirect inside a python string for a real redirect when stripping", () => {
    // office-output segment (out.docx) is dropped; the `>` inside the python string is not a redirect
    expect(nonOfficeGeneratorText(`uv run python -c "doc.save('out.docx'); x='a > b'"`)).toBe("")
  })

  test("strips a heredoc-body office .save() so a captured deck is not re-read as a write", () => {
    const cmd = "uv run python <<'PY'\nfrom pptx import Presentation\nprs.save('deck.pptx')\nPY"
    expect(officeOutputPaths(cmd)).toEqual(["deck.pptx"]) // captured exactly
    const remainder = nonOfficeGeneratorText(cmd)
    expect(remainder).not.toContain("deck.pptx") // the .save body line is dropped
    expect(isLikelyWriteCommand(remainder)).toBe(false) // so it is not double-counted as a write
  })

  test("does not read a > inside a heredoc python body as a real write-redirect", () => {
    // the heredoc body is stdin, not shell — `if total > 0:` must not surface a phantom
    // `> 0:` redirect that would falsely mark the captured deck's turn as uncaptured
    const cmd = "uv run python <<'PY'\nif total > 0:\n    prs.save('deck.pptx')\nPY"
    expect(officeOutputPaths(cmd)).toEqual(["deck.pptx"]) // captured exactly
    const remainder = nonOfficeGeneratorText(cmd)
    expect(remainder).toBe("") // no phantom `> 0:` redirect leaks out of the heredoc body
    expect(isLikelyWriteCommand(remainder)).toBe(false)
  })

  test("does not treat a null-device redirect on a captured generator as a side-effect write", () => {
    // silencing a captured office generator's stdout/stderr is not a file write, so the
    // turn must not be flagged as an uncaptured non-office side effect
    expect(nonOfficeGeneratorText("uv run python build.py -o report.docx >/dev/null")).toBe("")
    expect(nonOfficeGeneratorText("uv run python build.py -o report.docx 2>/dev/null")).toBe("")
    expect(nonOfficeGeneratorText("uv run python build.py -o report.docx >NUL")).toBe("")
    // a real file redirect alongside the null-device one still survives
    expect(nonOfficeGeneratorText("uv run python build.py -o report.docx 2>/dev/null > log.txt")).toBe(
      "> log.txt",
    )
  })

  test("keeps a real redirect on a heredoc opener line as a side-effect write", () => {
    // the `> log.txt` sits on the opener line (shell), not in the body (stdin) — dropping
    // the captured generator must still surface that log write, not swallow it
    const cmd = "uv run python <<'PY' > log.txt\nprs.save('deck.pptx')\nPY"
    expect(officeOutputPaths(cmd)).toEqual(["deck.pptx"]) // deck still captured exactly
    expect(nonOfficeGeneratorText(cmd)).toBe("> log.txt") // opener-line write survives
  })

  test("terminates a hyphenated heredoc delimiter so a trailing side-effect write survives", () => {
    // `<<PY-END` is a valid delimiter; if the parser stopped at `PY` the closing marker would
    // never match and the whole rest of the command (incl. `echo done > side.txt`) would be
    // swallowed into the heredoc body, hiding the real side-effect write
    const cmd = "uv run python <<PY-END\ndoc.save('a.docx')\nPY-END\necho done > side.txt"
    expect(officeOutputPaths(cmd)).toEqual(["a.docx"]) // deck captured, heredoc bounded
    expect(nonOfficeGeneratorText(cmd)).toBe("echo done > side.txt") // trailing write survives
  })
})
