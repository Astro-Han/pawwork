const officeOutputExtensions = new Set([".docx", ".xlsx", ".pptx", ".pdf"])

// The working-directory scan that backstops undeclared office writes deliberately
// omits .pdf: PDF generation is not wired to a runtime print tool yet, so a cwd scan
// never needs to surface a freshly generated .pdf, while ambient PDFs (scans,
// invoices) are common clutter that would exhaust the small capture budget and force
// a discovery overflow that drops real .docx/.xlsx/.pptx captures. An explicit
// `-o out.pdf` is still captured via the parsed output path, and .pdf still reads as
// a binary artifact. Revisit when PDF generation lands.
const discoverableOfficeExtensions = new Set([".docx", ".xlsx", ".pptx"])

type Segment = {
  text: string
}

// Collapse shell line continuations (a backslash immediately before a newline) so a
// generator wrapped across lines — `uv run python build.py \<newline> -o report.docx` — is
// treated as the single command the shell runs, not split at the newline. A backslash
// inside single quotes is literal (no continuation); elsewhere (unquoted or double-quoted)
// `\<newline>` is removed. Every other backslash sequence is preserved verbatim so the
// downstream tokenizer still sees escaped quotes like `-c "...save(\"x.docx\")"`.
function stripLineContinuations(command: string) {
  let out = ""
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (char === "\\" && quote !== "'") {
      if (command[index + 1] === "\n") {
        index += 1
        continue
      }
      if (command[index + 1] === "\r" && command[index + 2] === "\n") {
        index += 2
        continue
      }
      out += char
      if (index + 1 < command.length) {
        out += command[index + 1]
        index += 1
      }
      continue
    }
    if (quote) {
      out += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      out += char
      continue
    }
    out += char
  }
  return out
}

function fileExtension(file: string) {
  return file.match(/\.([^.\\/]+)$/)?.[0].toLowerCase() ?? ""
}

export function isOfficeOutputPath(file: string) {
  return officeOutputExtensions.has(fileExtension(file))
}

export function isDiscoverableOfficeOutput(file: string) {
  return discoverableOfficeExtensions.has(fileExtension(file))
}

// If a `<<`/`<<-` heredoc opens at `index`, return the index just past its whole body (the
// newline ending the closing-delimiter line, or the end of the string); else undefined.
// Newlines inside a heredoc body are stdin, not command separators, so the opener + body +
// closer stay in one segment — that keeps a `uv --directory ... <<PY .save(...) PY` chdir
// scoped to its own command instead of leaking to the next newline-separated command.
function skipHeredocBody(command: string, index: number) {
  let cursor = index + 2
  let stripTabs = false
  if (command[cursor] === "-") {
    stripTabs = true
    cursor += 1
  }
  while (cursor < command.length && (command[cursor] === " " || command[cursor] === "\t")) cursor += 1
  let delimiterQuote: "'" | '"' | undefined
  if (command[cursor] === "'" || command[cursor] === '"') {
    delimiterQuote = command[cursor] as "'" | '"'
    cursor += 1
  }
  let delimiter = ""
  while (cursor < command.length && /[A-Za-z0-9_]/.test(command[cursor])) {
    delimiter += command[cursor]
    cursor += 1
  }
  if (delimiterQuote && command[cursor] === delimiterQuote) cursor += 1
  if (!delimiter) return undefined
  // Scan for a line whose content (leading tabs stripped for `<<-`) is exactly the delimiter.
  while (cursor < command.length) {
    if (command[cursor] === "\n") {
      let lineStart = cursor + 1
      if (stripTabs) while (command[lineStart] === "\t") lineStart += 1
      let lineEnd = lineStart
      while (lineEnd < command.length && command[lineEnd] !== "\n") lineEnd += 1
      if (command.slice(lineStart, lineEnd).trimEnd() === delimiter) return lineEnd
    }
    cursor += 1
  }
  return command.length // unterminated heredoc: consume to end
}

export function commandSegments(command: string) {
  command = stripLineContinuations(command)
  const segments: Segment[] = []
  let start = 0
  let quote: "'" | '"' | undefined
  let index = 0
  while (index < command.length) {
    const char = command[index]
    if (quote) {
      if (char === quote) quote = undefined
      else if (char === "\\" && quote === '"') index += 1
      index += 1
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      index += 1
      continue
    }
    if (char === "<" && command[index + 1] === "<") {
      const bodyEnd = skipHeredocBody(command, index)
      if (bodyEnd !== undefined) {
        index = bodyEnd
        continue
      }
    }

    const next = command[index + 1]
    const currentDelimiter =
      char === "\n" || char === "\r"
        ? char
        : char === "&" && next === "&"
        ? "&&"
        : char === "|" && next === "|"
          ? "||"
          : char === ";" || char === "|"
            ? char
            : undefined
    if (!currentDelimiter) {
      index += 1
      continue
    }

    const text = command.slice(start, index).trim()
    if (text) segments.push({ text })
    index += currentDelimiter.length
    start = index
  }
  const text = command.slice(start).trim()
  if (text) segments.push({ text })
  return segments
}

export function tokenWords(command: string) {
  return commandSegments(command)
    .map((segment) => shellWords(segment.text).map((word) => word.toLowerCase()))
    .filter((words) => words.length > 0)
}

const outputFlags = new Set(["-o", "--out", "--output", "--outfile"])

// Redirect targets that discard output rather than write a file — a POSIX `/dev/null` or the
// Windows `NUL` device. A redirect to one of these is not a side-effect write to audit.
const nullDevices = new Set(["/dev/null", "nul"])

// Commands whose arguments are plain text, not python — an office-looking
// `.save('x.docx')` inside `echo "...save('x.docx')..."` is a quoted literal, not a
// write. The cross-segment `.save` scan skips these heads so such literals do not
// surface a phantom artifact; a heredoc's python body (head like `doc.save(...)`) is
// not a known command and is still scanned.
const saveScanSkipHeads = new Set(["echo", "printf", "cat", "grep", "rg", "egrep", "fgrep", "sed", "awk"])

// An output path is only trackable when it is a static literal. A value carrying an
// unexpanded shell variable (POSIX `$OUT`, Windows cmd `%OUT%`), command
// substitution, or glob (e.g. `-o "$OUT.docx"`, `-o "%OUT%.docx"`, ``-o `date`.docx``,
// `-o report-*.docx`) cannot be tracked verbatim — the artifact layer never runs the
// shell, so the literal would never match the real file. Drop it and let the cwd
// backstop discover the real output instead of tracking a phantom.
function isStaticOutputValue(value: string) {
  return !/[$`*?%[\]{}]/.test(value) && !value.startsWith("~")
}

function isRelativeOutputValue(value: string) {
  return !value.startsWith("/") && !value.startsWith("\\") && !/^[a-zA-Z]:[\\/]/.test(value)
}

// Whether an output value is one officeOutputPaths captures verbatim: a static office
// literal that isn't a cwd-relative path after a `cd` (which would resolve against the
// wrong directory). Such a value is handled by the exact-capture path and needs no cwd
// scan; anything else (dynamic, glob, or cwd-relative-after-cd) is an UNRESOLVED intent
// the backstop must scan for. Shared by officeOutputPaths and hasOfficeOutputIntent so
// the two never disagree on which outputs are exactly captured.
function isExactlyCapturableOutput(value: string, relativeUnresolved: boolean) {
  return (
    isOfficeOutputPath(value) &&
    isStaticOutputValue(value) &&
    !(relativeUnresolved && isRelativeOutputValue(value))
  )
}

// Whether an output-flag / .save value names something the cwd backstop could actually
// discover — a `.docx/.xlsx/.pptx` (NOT `.pdf`: discovery excludes it, so a dynamic
// `.pdf` would trigger a scan that can never find it; static `-o report.pdf` is still
// captured exactly by officeOutputPaths). Also true when the extension is HIDDEN inside
// a dynamic value (`-o "$OUT"`, `-o "%OUT%"`) — it may expand to a discoverable office
// file, so the backstop should scan. A visible non-discoverable extension (`$OUT.pdf`,
// `$OUT.txt`) is not.
function dynamicOutputCouldBeDiscoverable(value: string) {
  if (isDiscoverableOfficeOutput(value)) return true
  if (!isStaticOutputValue(value)) return fileExtension(value) === ""
  return false
}

// Whether an office output the exact parser could NOT capture still counts as intent — so
// the backstop scans and, if nothing is found, flags the turn uncaptured instead of losing
// the deliverable. A STATIC office path (a KNOWN filename, including `.pdf`) always counts
// when unresolved: even though `.pdf` is excluded from discovery, an explicitly-named
// `cd reports && ... -o report.pdf` must become an uncaptured mark rather than vanish. A
// DYNAMIC value counts only when it could be a discoverable office output — a visible
// dynamic `.pdf` (`-o "$OUT.pdf"`) can't be found and names no concrete file, so it stays
// out. An exactly-capturable output is not intent (it is captured precisely).
function unresolvedOfficeIntent(value: string, relativeUnresolved: boolean) {
  if (isExactlyCapturableOutput(value, relativeUnresolved)) return false
  if (isOfficeOutputPath(value) && isStaticOutputValue(value)) return true
  return dynamicOutputCouldBeDiscoverable(value)
}

// The path argument of a python `.save(...)` call — the documented python-docx / openpyxl
// / python-pptx persistence call. Allows optional whitespace before `(`, python string
// prefixes (`r`/`b`/`u`/`f`, e.g. `.save(r"out.docx")`), and an optional leading backslash
// so an escaped opening quote in `-c "...save(\"out.docx\")"` is matched. The value run
// `(?:[^"'\\]|\\[^"'])*` allows backslash PATH SEPARATORS (Windows `r"C:\dir\out.docx"`)
// while still ending at an escaped closing quote (`\"`/`\'`), which the run rejects. Built
// fresh per call so the shared /g lastIndex never leaks between callers.
const saveOutputPattern = String.raw`\.save\s*\(\s*[rbuf]*\\?["']((?:[^"'\\]|\\[^"'])*)`
function saveOutputValues(text: string) {
  const values: string[] = []
  for (const match of text.matchAll(new RegExp(saveOutputPattern, "gi"))) {
    if (match[1]) values.push(match[1])
  }
  return values
}

// A native office deliverable is produced by a python / uv-run generator command
// (the office-* skills run everything through `uv run python ...`). Gating on the
// generator command keeps a non-output `-o` on some other tool — e.g. grep's
// "only matching" flag in `grep -o report.docx file` — from being read as an
// office write.
function isOfficeGeneratorSegment(words: string[]) {
  const { head, rest } = commandHead(words)
  const lower = head?.toLowerCase()
  // A direct python interpreter head — `python`, `python3`, or a versioned `python3.12` /
  // `python2` (`/^python\d/`, the same rule `isPythonCommandToken` uses under `uv run`). A
  // versioned interpreter must be recognized here too, else `python3.12 build.py -o x.docx`
  // is judged a non-generator and its office output is silently neither captured nor flagged.
  if (lower && (lower === "python" || /^python\d/.test(lower))) return true
  // A `uv run ...` invocation — the office-* skills always run through `uv run`, and uv
  // permits global options before the subcommand (`uv --directory work run ...`,
  // `uv --offline run ...`), so the `run` subcommand token is the signal rather than its
  // position. This deliberately admits `uv run <anything>` (including `uv run script.py`,
  // where uv runs a bare script with no explicit `python`); the office-output value gates
  // (isOfficeOutputPath / dynamicOutputCouldBeDiscoverable) keep a non-office `uv run`
  // from producing a phantom capture.
  if (lower === "uv" && rest.some((word) => word.toLowerCase() === "run")) return true
  return false
}

// The python program token in a `uv run` invocation — `python`, `python3`, a versioned
// `python3.12`, or a bare `script.py`. Marks where uv's own options end and the executed
// command (and its args) begin.
function isPythonCommandToken(word: string) {
  const low = word.toLowerCase()
  return low === "python" || /^python\d/.test(low) || low.endsWith(".py")
}

// uv's `--directory <dir>` (unlike `--project`, which only affects project discovery)
// changes the working directory before running the command, so a RELATIVE output names a
// file under that directory, not the shell cwd. The exact parser cannot resolve it, so —
// like a prior `cd` — it must defer to the discovery backstop. `--directory` is accepted
// both as a global option (`uv --directory x run ...`) and as a `uv run` option
// (`uv run --directory x python ...`) — both chdir — so scan up to the executed python
// command; a `--directory` after that belongs to the script's own args, not uv. A
// python-ish token that is the VALUE of uv's `--python`/`-p` interpreter selector
// (`uv run --python python3 --directory work python x.py`) is NOT the command, so it does
// not stop the scan.
function uvChangesDirectory(words: string[]) {
  const { head, rest } = commandHead(words)
  if (head?.toLowerCase() !== "uv") return false
  let previous: string | undefined
  for (const word of rest) {
    const low = word.toLowerCase()
    if (low === "--directory" || low.startsWith("--directory=")) return true
    if (isPythonCommandToken(word) && previous !== "--python" && previous !== "-p") break
    previous = low
  }
  return false
}

function isCwdChangeSegment(words: string[]) {
  const lower = commandHead(words).head?.toLowerCase()
  return lower === "cd" || lower === "pushd" || lower === "popd"
}

function shouldScanSaveSegment(words: string[], isGeneratorCommand: boolean) {
  if (!isGeneratorCommand) return false
  if (isOfficeGeneratorSegment(words)) return true
  const head = commandHead(words).head?.toLowerCase() ?? ""
  if (saveScanSkipHeads.has(head)) return false
  return head.includes(".save(")
}

// Whether a native office generator NAMED a discoverable office deliverable that the
// parser could not track to an exact path — an -o/--out flag or a python `.save(...)`
// whose value is `.docx/.xlsx/.pptx` but is dynamic (`-o "$OUT.docx"`, `-o "%OUT%.docx"`,
// a glob, a cwd-relative path after `cd`), OR whose whole name is hidden in a variable
// (`-o "$OUT"`). Such a command clearly intends to write an office file the cwd backstop
// can find, so it must scan. Crucially this is NOT true for a bare read-only invocation
// that names no output at all — `uv run pytest`, `uv run python read_docx.py input.docx`
// — nor for a dynamic `.pdf` (discovery can't find it; that relies on expected_outputs
// or an exact `-o report.pdf`). A generator whose ONLY output is an internal
// `doc.save(...)` inside a script file it runs (invisible to the command text) is also
// not scanned here; that deliverable is captured via the model-declared
// `expected_outputs`, the instructed primary path.
export function hasOfficeOutputIntent(command: string) {
  const segments = commandSegments(command)
  const isGeneratorCommand = segments.some((segment) => isOfficeGeneratorSegment(shellWords(segment.text)))
  if (!isGeneratorCommand) return false
  // `cd` changes the parent shell cwd persistently (across `&&`/`;`); `uv --directory` only
  // changes its own command's cwd, and its heredoc body is now one segment, so it is judged
  // per segment with no cross-command propagation.
  let cdChanged = false
  for (const segment of segments) {
    const words = shellWords(segment.text)
    const relativeUnresolved = cdChanged || uvChangesDirectory(words)
    if (isOfficeGeneratorSegment(words)) {
      for (let index = 0; index < words.length; index++) {
        const word = words[index]
        const equals = word.indexOf("=")
        const flag = (equals >= 0 ? word.slice(0, equals) : word).toLowerCase()
        if (!outputFlags.has(flag)) continue
        const value = equals >= 0 ? word.slice(equals + 1) : words[index + 1]
        // Intent means an office output officeOutputPaths could NOT capture exactly, so a
        // command mixing an exact output with a dynamic one still reports intent for the
        // dynamic part and triggers the cwd scan.
        if (value && unresolvedOfficeIntent(value, relativeUnresolved)) return true
      }
    }
    if (shouldScanSaveSegment(words, isGeneratorCommand)) {
      for (const value of saveOutputValues(segment.text)) {
        if (unresolvedOfficeIntent(value, relativeUnresolved)) return true
      }
    }
    if (isCwdChangeSegment(words)) cdChanged = true
  }
  return false
}

// Explicit office output paths a generator command names for itself: either an
// -o/--out/--output/--outfile flag, or a python `.save("out.docx")` call (the
// documented python-docx / openpyxl / python-pptx persistence call, which has no
// output flag). Case-preserving (the returned path is tracked verbatim) and
// quote-aware, so `-o "Quarterly Report.docx"` is captured while an office-looking
// string inside a quoted literal (`echo "usage: -o x.docx"`) is not.
export function officeOutputPaths(command: string) {
  const segments = commandSegments(command)
  const isGeneratorCommand = segments.some((segment) => isOfficeGeneratorSegment(shellWords(segment.text)))
  const paths: string[] = []
  // `cd` changes the parent shell cwd persistently (across `&&`/`;`); `uv --directory` only
  // changes its own command's cwd, and its heredoc body is one segment, so it is judged per
  // segment with no cross-command propagation.
  let cdChanged = false
  for (const segment of segments) {
    const words = shellWords(segment.text)
    const relativeUnresolved = cdChanged || uvChangesDirectory(words)
    // Output flags are gated per segment so a non-output `-o` on another tool in a
    // chained command (e.g. `grep -o report.docx file && ...`) is not read as a write.
    if (isOfficeGeneratorSegment(words)) {
      for (let index = 0; index < words.length; index++) {
        const word = words[index]
        const equals = word.indexOf("=")
        const flag = (equals >= 0 ? word.slice(0, equals) : word).toLowerCase()
        if (!outputFlags.has(flag)) continue
        const value = equals >= 0 ? word.slice(equals + 1) : words[index + 1]
        if (value && isExactlyCapturableOutput(value, relativeUnresolved)) paths.push(value)
      }
    }
    // `.save(...)` is python-specific. Scan generator segments (a heredoc body is part of
    // the generator segment); do not let arbitrary later commands like
    // `node -e "...save('x.docx')"` create phantom exact artifacts.
    if (shouldScanSaveSegment(words, isGeneratorCommand)) {
      for (const value of saveOutputValues(segment.text)) {
        if (isExactlyCapturableOutput(value, relativeUnresolved)) paths.push(value)
      }
    }
    if (isCwdChangeSegment(words)) cdChanged = true
  }
  return Array.from(new Set(paths))
}

// The write-redirections carried by a single command segment, extracted quote-aware so
// a `>` inside a python string (`-c "print('a > b')"`) is not mistaken for one. Returns
// e.g. `> log.txt` / `2> err.txt` / `>> out`. Bare input `<` is not a write. A `<<`
// heredoc BODY is stdin, not shell — only the body (from the opener line's newline through
// the closing delimiter) is skipped, so ordinary python there (`if total > 0:`, an
// SVG/HTML `>` literal) is never read as a redirect, while a real redirect ON the opener
// line (`uv run python <<'PY' > log.txt`) is still captured.
function segmentWriteRedirects(segmentText: string) {
  const parts: string[] = []
  let index = 0
  let quote: "'" | '"' | undefined
  let pendingBodyEnd: number | undefined
  while (index < segmentText.length) {
    const char = segmentText[index]
    if (quote) {
      if (char === "\\" && quote === '"') {
        index += 2
        continue
      }
      if (char === quote) quote = undefined
      index++
      continue
    }
    // The heredoc opener line is still shell — keep scanning it for redirects. Once its
    // terminating newline is reached, jump past the whole heredoc body (stdin).
    if (pendingBodyEnd !== undefined && char === "\n") {
      index = pendingBodyEnd
      pendingBodyEnd = undefined
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      index++
      continue
    }
    if (char === "<" && segmentText[index + 1] === "<") {
      const bodyEnd = skipHeredocBody(segmentText, index)
      if (bodyEnd !== undefined) {
        // Note the body span, but advance only past the `<<` operator so a same-line
        // redirect after the delimiter word is still seen before the body is skipped.
        pendingBodyEnd = bodyEnd
        index += 2
        continue
      }
    }
    const op = segmentText.slice(index).match(/^(?:&>>?|[0-9]*>>?|[0-9]*>\||[0-9]*<>)/)
    if (op) {
      let cursor = index + op[0].length
      while (cursor < segmentText.length && /\s/.test(segmentText[cursor])) cursor++
      let target = ""
      let targetQuote: "'" | '"' | undefined
      while (cursor < segmentText.length) {
        const tc = segmentText[cursor]
        if (targetQuote) {
          if (tc === targetQuote) targetQuote = undefined
          else target += tc
          cursor++
          continue
        }
        if (tc === "'" || tc === '"') {
          targetQuote = tc
          cursor++
          continue
        }
        if (/\s/.test(tc)) break
        target += tc
        cursor++
      }
      // A redirect to a null device (`>/dev/null`, `2>/dev/null`, Windows `>NUL`) discards
      // output — it is never an auditable file write, so it must not make a cleanly-captured
      // office generator (`... -o report.docx >/dev/null`) read as a non-office side effect.
      if (target && !nullDevices.has(target.toLowerCase())) parts.push(`${op[0]} ${target}`)
      index = cursor
      continue
    }
    index++
  }
  return parts.join(" ")
}

// Whether a single segment's write IS an office output we capture exactly (a static
// -o/.save), will discover (a dynamic office output), or is the heredoc/split python
// body carrying a generator command's `.save('...office')` (captured by officeOutputPaths'
// cross-segment scan). Only such a segment may be dropped from the side-effect check; a
// python segment that named NO office output — `python setup.py build`, a bare
// `python analyze.py > log` — is a potential non-office write and must be kept so the
// write heuristic can judge it.
function segmentIsCapturedOfficeOutput(segmentText: string, isGeneratorCommand: boolean) {
  const words = shellWords(segmentText)
  if (
    isOfficeGeneratorSegment(words) &&
    (officeOutputPaths(segmentText).length > 0 || hasOfficeOutputIntent(segmentText))
  )
    return true
  // A heredoc / split python body line whose `.save('...office')` the cross-segment scan
  // already captured for the whole generator command.
  if (isGeneratorCommand && shouldScanSaveSegment(words, isGeneratorCommand)) {
    for (const value of saveOutputValues(segmentText)) {
      if (isOfficeOutputPath(value)) return true
    }
  }
  return false
}

// The command with its office-output-producing COMMANDS removed but their
// write-redirections kept, so the caller can check whether what *remains* is still a
// write. An office generator's -o/.save output is captured exactly (via
// officeOutputPaths), so dropping that command keeps a pure `... -o a.docx` from reading
// as a write, while a same-segment redirect `... -o a.docx > log.txt` leaves `> log.txt`.
// A python segment that named no office output is kept intact, so `python setup.py build`
// or `uv run python analyze.py > results.txt` still reads as the write it is. Segments
// are re-joined with `;` (any delimiter works — the write heuristic re-splits on it).
export function nonOfficeGeneratorText(command: string) {
  const segments = commandSegments(command)
  const isGeneratorCommand = segments.some((segment) => isOfficeGeneratorSegment(shellWords(segment.text)))
  return segments
    .map((segment) =>
      segmentIsCapturedOfficeOutput(segment.text, isGeneratorCommand)
        ? segmentWriteRedirects(segment.text)
        : segment.text,
    )
    .filter((text) => text.length > 0)
    .join(" ; ")
}

export function commandHead(words: string[]) {
  let index = 0
  while (true) {
    const word = words[index]
    if (!word) break
    if (word.includes("=") && !word.startsWith("-") && !word.startsWith("=")) {
      index++
      continue
    }
    if (["command", "sudo", "env"].includes(word)) {
      index++
      continue
    }
    break
  }
  return { head: words[index], next: words[index + 1], rest: words.slice(index + 1), index }
}

function shellWords(text: string) {
  const words: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (char === quote) {
        quote = undefined
        continue
      }
      if (char === "\\" && quote === '"' && index + 1 < text.length) {
        index++
        current += text[index]
        continue
      }
      current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current) words.push(current)
  return words
}
