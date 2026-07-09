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
    // `uv run` can execute a console script, not just python — the command boundary is the first
    // positional, so `render-pdf`'s own `--directory` arg is NOT uv's chdir and the relative
    // output stays exactly captured (matters most for .pdf, which discovery can't recover)
    ["uv run render-pdf --directory inputs -o report.pdf", ["report.pdf"]],
    ["uv run gen-deck --directory sub -o slides.pptx", ["slides.pptx"]],
    // a `--` ends uv option parsing; the token after it is the command, its `--directory` is a
    // script arg
    ["uv run -- build-report --directory x -o report.docx", ["report.docx"]],
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
    // an unquoted POSIX backslash-escaped space binds the space into one filename token, so
    // `-o Quarterly\ Report.docx` names a single `Quarterly Report.docx`, captured exactly
    [String.raw`uv run python build.py -o Quarterly\ Report.docx`, ["Quarterly Report.docx"]],
    // the backslash-space unescape must NOT touch backslashes before non-space chars, so a
    // Windows-style `-o` path keeps its separators (still captured exactly, verbatim)
    [String.raw`uv run python build.py -o C:\out\report.docx`, [String.raw`C:\out\report.docx`]],
    // a DOUBLE-QUOTED Windows path keeps its separators too: POSIX drops a backslash inside
    // double quotes only before " \ $ `, so `C:\Users\me\deck.pptx` is captured verbatim, not
    // mangled to `C:Usersmedeck.pptx`. Quoting is the natural form when the path has spaces.
    [String.raw`uv run python build.py -o "C:\Users\me\deck.pptx"`, [String.raw`C:\Users\me\deck.pptx`]],
    [String.raw`uv run python build.py -o "C:\Program Files\report.docx"`, [String.raw`C:\Program Files\report.docx`]],
    // an unquoted backslash-escaped shell metacharacter is a literal in the filename: the real
    // file is `R&D.docx`, so capture that, not the literal-backslash `R\&D.docx`
    [String.raw`uv run python build.py -o R\&D.docx`, ["R&D.docx"]],
    // an escaped `;` must not tear the filename into a second command segment, and its real
    // name is `report;q.docx`
    [String.raw`uv run python build.py -o report\;q.docx`, ["report;q.docx"]],
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
    // a python-like VALUE of any value-option (`--project python`) must not stop the scan and
    // hide the later `--directory` chdir — else the relative output looks exact in the shell cwd
    "uv --project python --directory work run python make.py -o report.docx",
    // the value-option table must cover uv run's selection flags too (`--package`, `--extra`,
    // `--group`, ...) — a python-shaped value there must not hide the later `--directory` chdir
    "uv run --package python --directory work python make.py -o report.docx",
    "uv run --group python --directory work python make.py -o report.docx",
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
    // a `uv run` chdir BEFORE a console-script command is real → relative output unresolved
    "uv run --directory work render-pdf -o report.docx",
    // uv global options before `run` must not hide the dynamic output
    'uv --directory work run python build.py -o "$OUT.docx"',
    // a RELATIVE output under `uv --directory` chdir is unresolved → intent → cwd scan
    "uv --directory work run python build.py -o report.docx",
    "uv run --directory work python build.py -o report.docx", // --directory as a `uv run` option also chdirs
    "uv --directory work run python <<'PY'\ndoc.save('out.docx')\nPY", // heredoc .save inherits the --directory chdir
    "uv run --python python3 --directory work python build.py -o report.docx", // --python value collision must still see --directory
    // a value-option value (`--project python`) shaped like a python command must not hide the
    // later `--directory` chdir → the relative output stays unresolved intent
    "uv --project python --directory work run python make.py -o report.docx",
    // uv run selection flags take a value too — `--package python` / `--group python` must not
    // stop the scan on their python-shaped value and hide the `--directory` chdir
    "uv run --package python --directory work python make.py -o report.docx",
    "uv run --group python --directory work python make.py -o report.docx",
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

  test("surfaces an office generator wrapped in a PowerShell if ($?) block", () => {
    // Windows PowerShell 5.1 has no `&&`, so the shell prompt instructs dependent chaining as
    // `cmd1; if ($?) { cmd2 }`. The wrapped generator must still be captured / audited, not hidden
    // under the `if` head. A standalone `{`/`}` groups commands; `${VAR}` / brace-expansion stay intact.
    const exact = "uv run python prep.py; if ($?) { uv run python build.py -o report.docx }"
    expect(officeOutputPaths(exact)).toEqual(["report.docx"]) // captured despite the if-wrapper
    const dynamic = `uv run python prep.py; if ($?) { uv run python build.py -o "$OUT.docx" }`
    expect(hasOfficeOutputIntent(dynamic)).toBe(true) // dynamic wrapped output still scans
    const sideEffect = "uv run python build.py -o a.docx; if ($?) { echo x > side.txt }"
    expect(isLikelyWriteCommand(nonOfficeGeneratorText(sideEffect))).toBe(true) // wrapped write audited
    // a bash `{ cmd; }` group is unwrapped the same way
    expect(officeOutputPaths("{ uv run python build.py -o report.docx; }")).toEqual(["report.docx"])
    // a brace glued to a word/`$` is NOT a block brace: brace-expansion / ${VAR} outputs are left
    // intact (dynamic → discovery), not torn across a phantom `{`/`}` split
    expect(hasOfficeOutputIntent("uv run python build.py -o report{1,2}.docx")).toBe(true)
    expect(hasOfficeOutputIntent("uv run python build.py -o ${OUT}.docx")).toBe(true)
  })

  test("keeps a command chained on the heredoc opener line as its own side-effect write", () => {
    // `<<'PY'; touch side.txt` / `<<'PY' && touch side.txt` put `touch` on the opener line
    // (shell), before the body (stdin). Skipping the whole heredoc span would bury `touch` inside
    // the captured office segment and hide it from the audit — the body must be re-attached to the
    // generator segment while the trailing command splits off into its own segment.
    for (const sep of [";", "&&"]) {
      const cmd = `uv run python <<'PY' ${sep} touch side.txt\ndoc.save('out.docx')\nPY`
      expect(officeOutputPaths(cmd)).toEqual(["out.docx"]) // generator + body still captured
      expect(isLikelyWriteCommand(nonOfficeGeneratorText(cmd))).toBe(true) // touch survives the audit
    }
  })

  test("terminates a hyphenated heredoc delimiter so a trailing side-effect write survives", () => {
    // `<<PY-END` is a valid delimiter; if the parser stopped at `PY` the closing marker would
    // never match and the whole rest of the command (incl. `echo done > side.txt`) would be
    // swallowed into the heredoc body, hiding the real side-effect write
    const cmd = "uv run python <<PY-END\ndoc.save('a.docx')\nPY-END\necho done > side.txt"
    expect(officeOutputPaths(cmd)).toEqual(["a.docx"]) // deck captured, heredoc bounded
    expect(nonOfficeGeneratorText(cmd)).toBe("echo done > side.txt") // trailing write survives
  })

  test("terminates a backslash-quoted heredoc delimiter so a trailing side-effect write survives", () => {
    // `<<\PY` is valid shell: the backslash quotes the delimiter (no body expansion) and the
    // closing line is `PY`. If the parser read the delimiter as `\PY` it would never match the
    // `PY` closer and swallow the rest of the command (incl. `echo done > side.txt`) as body.
    const cmd = "uv run python <<\\PY\ndoc.save('a.docx')\nPY\necho done > side.txt"
    expect(officeOutputPaths(cmd)).toEqual(["a.docx"]) // deck captured, heredoc bounded at `PY`
    expect(nonOfficeGeneratorText(cmd)).toBe("echo done > side.txt") // trailing write survives
  })

  test("a trailing backslash inside the heredoc body does not swallow the next command", () => {
    // The body's last line is `# \` (a comment ending in a backslash). Line-continuation
    // stripping must NOT collapse that `\`-newline — doing so would fuse the closing `PY` into
    // the body, leave the heredoc unterminated, and hide `echo done > notes.txt` from the audit.
    const cmd = "uv run python <<'PY'\nDocument().save('deck.docx')\n# \\\nPY\necho done > notes.txt"
    expect(officeOutputPaths(cmd)).toEqual(["deck.docx"]) // deck captured, heredoc bounded at `PY`
    expect(nonOfficeGeneratorText(cmd)).toBe("echo done > notes.txt") // trailing write survives
  })
})
