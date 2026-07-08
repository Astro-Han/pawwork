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

function fileExtension(file: string) {
  return file.match(/\.([^.\\/]+)$/)?.[0].toLowerCase() ?? ""
}

export function isOfficeOutputPath(file: string) {
  return officeOutputExtensions.has(fileExtension(file))
}

export function isDiscoverableOfficeOutput(file: string) {
  return discoverableOfficeExtensions.has(fileExtension(file))
}

export function commandSegments(command: string) {
  const segments: Segment[] = []
  let start = 0
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (quote) {
      if (char === quote) quote = undefined
      if (char === "\\" && quote === '"') index++
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
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
    if (!currentDelimiter) continue

    const text = command.slice(start, index).trim()
    if (text) segments.push({ text })
    index += currentDelimiter.length - 1
    start = index + 1
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

// A native office deliverable is produced by a python / uv-run generator command
// (the office-* skills run everything through `uv run python ...`). Gating on the
// generator command keeps a non-output `-o` on some other tool — e.g. grep's
// "only matching" flag in `grep -o report.docx file` — from being read as an
// office write.
function isOfficeGeneratorSegment(words: string[]) {
  const { head, next } = commandHead(words)
  const lower = head?.toLowerCase()
  if (lower === "python" || lower === "python3") return true
  if (lower === "uv" && next?.toLowerCase() === "run") return true
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
  for (const segment of segments) {
    const words = shellWords(segment.text)
    if (isOfficeGeneratorSegment(words)) {
      for (let index = 0; index < words.length; index++) {
        const word = words[index]
        const equals = word.indexOf("=")
        const flag = (equals >= 0 ? word.slice(0, equals) : word).toLowerCase()
        if (!outputFlags.has(flag)) continue
        const value = equals >= 0 ? word.slice(equals + 1) : words[index + 1]
        if (value && dynamicOutputCouldBeDiscoverable(value)) return true
      }
    }
    if (shouldScanSaveSegment(words, isGeneratorCommand)) {
      for (const match of segment.text.matchAll(/\.save\s*\(\s*[rbuf]*\\?["']([^"'\\]+)/gi)) {
        if (dynamicOutputCouldBeDiscoverable(match[1])) return true
      }
    }
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
  let cwdChangedBeforeSegment = false
  for (const segment of segments) {
    const words = shellWords(segment.text)
    // Output flags are gated per segment so a non-output `-o` on another tool in a
    // chained command (e.g. `grep -o report.docx file && ...`) is not read as a write.
    if (isOfficeGeneratorSegment(words)) {
      for (let index = 0; index < words.length; index++) {
        const word = words[index]
        const equals = word.indexOf("=")
        const flag = (equals >= 0 ? word.slice(0, equals) : word).toLowerCase()
        if (!outputFlags.has(flag)) continue
        const value = equals >= 0 ? word.slice(equals + 1) : words[index + 1]
        if (
          value &&
          isOfficeOutputPath(value) &&
          isStaticOutputValue(value) &&
          !(cwdChangedBeforeSegment && isRelativeOutputValue(value))
        )
          paths.push(value)
      }
    }
    // `.save(...)` is python-specific. Scan generator segments directly, and scan a
    // split heredoc/python body only when the segment itself looks like a save call;
    // do not let arbitrary later commands like `node -e "...save('x.docx')"` create
    // phantom exact artifacts.
    if (shouldScanSaveSegment(words, isGeneratorCommand)) {
      // Allow optional whitespace before `(`, optional python string prefixes
      // (`r`/`b`/`u`/`f`, e.g. `.save(r"out.docx")`), and an optional backslash before the
      // quote so an escaped inner quote in `-c "...save(\"out.docx\")"` is matched too.
      for (const match of segment.text.matchAll(/\.save\s*\(\s*[rbuf]*\\?["']([^"'\\]+)/gi)) {
        if (
          isOfficeOutputPath(match[1]) &&
          isStaticOutputValue(match[1]) &&
          !(cwdChangedBeforeSegment && isRelativeOutputValue(match[1]))
        )
          paths.push(match[1])
      }
    }
    if (isCwdChangeSegment(words)) cwdChangedBeforeSegment = true
  }
  return Array.from(new Set(paths))
}

// The write-redirections carried by a single command segment, extracted quote-aware so
// a `>` inside a python string (`-c "print('a > b')"`) is not mistaken for one. Returns
// e.g. `> log.txt` / `2> err.txt` / `>> out`. Bare input `<` is not a write.
function segmentWriteRedirects(segmentText: string) {
  const parts: string[] = []
  let index = 0
  let quote: "'" | '"' | undefined
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
    if (char === "'" || char === '"') {
      quote = char
      index++
      continue
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
      if (target) parts.push(`${op[0]} ${target}`)
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
    for (const match of segmentText.matchAll(/\.save\s*\(\s*[rbuf]*\\?["']([^"'\\]+)/gi)) {
      if (isOfficeOutputPath(match[1])) return true
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
