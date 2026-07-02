import log from "electron-log/main.js"
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"

const MAX_LOG_AGE_DAYS = 7
const TAIL_LINES = 1000
// Read at most this many bytes from the END of each log file. The main log rotates at 5 MB (maxSize
// below), but the backend log path is external and unbounded — without this a multi-GB log would
// load fully into memory just to take the tail. This also bounds any single line, so no separate
// per-line cap is needed (and a pre-redaction per-line cut would risk slicing a secret's prefix off).
const TAIL_MAX_BYTES = 512 * 1024
const CONSOLE_TRANSPORT_INITIALIZED = Symbol.for("pawwork.consoleTransportInitialized")

export function initLogging() {
  log.transports.file.maxSize = 5 * 1024 * 1024
  initConsoleTransport()
  cleanup()
  return log
}

export function tail(): string {
  return tailFile(filePath())
}

export function diagnosticsLogTail(input: { backendLogPath?: string | null } = {}): string {
  const mainPath = filePath()
  const sections = [`== Main process log: ${mainPath} ==\n${tailFile(mainPath) || "(empty)"}`]
  const backendLogPath = input.backendLogPath
  sections.push(
    backendLogPath
      ? `== Backend log: ${backendLogPath} ==\n${tailFile(backendLogPath) || "(empty)"}`
      : "== Backend log: unavailable ==",
  )
  return sections.join("\n\n")
}

// Read up to maxBytes from the end of the file without loading the whole thing. truncatedHead is
// true when the file was larger, so the caller can drop the (likely partial) first line.
function readTailBytes(path: string, maxBytes: number): { text: string; truncatedHead: boolean } {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const size = fstatSync(fd).size
    const readBytes = Math.min(size, maxBytes)
    const start = size - readBytes
    const buffer = Buffer.allocUnsafe(readBytes)
    let offset = 0
    while (offset < readBytes) {
      const read = readSync(fd, buffer, offset, readBytes - offset, start + offset)
      if (read <= 0) break
      offset += read
    }
    return { text: buffer.toString("utf8", 0, offset), truncatedHead: start > 0 }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function tailFile(path: string): string {
  try {
    const { text, truncatedHead } = readTailBytes(path, TAIL_MAX_BYTES)
    const lines = text.split("\n")
    // Started mid-file: the first line is a fragment (and may begin on a split multibyte char). Drop it
    // even when it is the only line, so only COMPLETE lines are emitted — emitting a mid-line fragment,
    // or head-cutting a long line here (before redaction), could leave a token with its recognizable
    // prefix sliced off so the downstream redactor no longer matches it. A multi-line secret whose
    // header (e.g. a PEM key's BEGIN) is stranded outside the window is handled at the redaction layer,
    // which scrubs bare base64 key bodies directly (problem-report-redact.ts) — not by line surgery here.
    if (truncatedHead) lines.shift()
    return lines.slice(Math.max(0, lines.length - TAIL_LINES)).join("\n")
  } catch {
    return ""
  }
}

export function filePath() {
  return log.transports.file.getFile().path
}

function cleanup() {
  const path = filePath()
  const dir = dirname(path)
  const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000

  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry)
    try {
      const info = statSync(file)
      if (!info.isFile()) continue
      if (info.mtimeMs < cutoff) unlinkSync(file)
    } catch {
      continue
    }
  }
}

function initConsoleTransport() {
  const transport = log.transports.console as typeof log.transports.console & {
    [CONSOLE_TRANSPORT_INITIALIZED]?: boolean
  }
  if (transport[CONSOLE_TRANSPORT_INITIALIZED]) return
  transport[CONSOLE_TRANSPORT_INITIALIZED] = true

  const write = transport.writeFn.bind(transport)
  transport.writeFn = (options) => {
    try {
      write(options)
    } catch (err) {
      if (!isBrokenPipe(err)) throw err
      transport.level = false
    }
  }
}

function isBrokenPipe(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EPIPE"
}
