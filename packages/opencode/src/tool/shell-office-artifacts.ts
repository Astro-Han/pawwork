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
        if (value && isOfficeOutputPath(value)) paths.push(value)
      }
    }
    // `.save(...)` is python-specific, so once the command is a python/uv generator it
    // is safe to scan every segment — a heredoc body or inline `-c` script may split
    // the call into its own segment on a `;` or newline. Skip segments headed by a
    // known text command so `.save` inside `echo "...save('x.docx')..."` stays a
    // literal.
    if (isGeneratorCommand && !saveScanSkipHeads.has(commandHead(words).head?.toLowerCase() ?? "")) {
      // Allow an optional backslash before the quote so an escaped inner quote in a
      // double-quoted `-c "...save(\"out.docx\")"` is matched as well as `save('x')`.
      for (const match of segment.text.matchAll(/\.save\(\s*\\?["']([^"'\\]+)/gi)) {
        if (isOfficeOutputPath(match[1])) paths.push(match[1])
      }
    }
  }
  return Array.from(new Set(paths))
}

// The command with its office-generator segments removed. An office generator's
// output is captured exactly (via officeOutputPaths), so the caller checks whether
// what *remains* is still a write — a chained side effect like
// `... -o a.docx && echo x > notes.txt` leaves `echo x > notes.txt`, while a pure
// `... -o a.docx` leaves nothing. Segments are re-joined with `;` (any delimiter
// works — the write heuristic re-splits on it).
export function nonOfficeGeneratorText(command: string) {
  return commandSegments(command)
    .filter((segment) => !isOfficeGeneratorSegment(shellWords(segment.text)))
    .map((segment) => segment.text)
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
