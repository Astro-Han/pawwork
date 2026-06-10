import log from "electron-log/main.js"
import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"

const MAX_LOG_AGE_DAYS = 7
const TAIL_LINES = 1000
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

function tailFile(path: string): string {
  try {
    const contents = readFileSync(path, "utf8")
    const lines = contents.split("\n")
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
