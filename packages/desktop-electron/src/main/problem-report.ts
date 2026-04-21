const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

export type ProblemReportDiagnostics = {
  appVersion: string
  channel: string
  packaged: boolean
  updaterEnabled: boolean
  platform: NodeJS.Platform | string
  osVersion: string
  arch: string
  electronVersion: string
  locale: string
  route: string
  directory: string | null
  sessionID: string | null
  logPath: string
}

export type SessionExport =
  | { status: "none" }
  | { status: "failed"; error: string }
  | { status: "ok"; info: unknown; messages: unknown[] }

type Input = {
  diagnostics: ProblemReportDiagnostics
  logTail: string
  sessionExport: SessionExport
}

type Options = {
  maxBytes?: number
}

type Payload = {
  reportVersion: 1
  generatedAt: string
  diagnostics: ProblemReportDiagnostics
  logTail: string
  sessionExport: SessionExport
  truncation: {
    omittedMessages: number
    omittedLogBytes: number
    omittedSessionInfoBytes: number
    omittedDiagnosticsBytes: number
  }
}

function bytes(value: string) {
  return Buffer.byteLength(value, "utf8")
}

function jsonBytes(value: unknown) {
  return bytes(JSON.stringify(value) ?? "")
}

function markdown(payload: Payload) {
  return [
    "# PawWork Problem Report",
    "",
    "Paste this report into the feedback form after reviewing it.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    "",
  ].join("\n")
}

function sessionMessages(sessionExport: SessionExport) {
  return sessionExport.status === "ok" ? sessionExport.messages : []
}

function withMessages(sessionExport: SessionExport, messages: unknown[]): SessionExport {
  if (sessionExport.status !== "ok") return sessionExport
  return { ...sessionExport, messages }
}

function withSessionInfo(sessionExport: SessionExport, info: unknown): SessionExport {
  if (sessionExport.status !== "ok") return sessionExport
  return { ...sessionExport, info }
}

function truncateString(value: string, limit: number) {
  return value.length > limit ? value.slice(0, limit) : value
}

function truncateDiagnostics(diagnostics: ProblemReportDiagnostics, stringLimit: number): ProblemReportDiagnostics {
  return {
    ...diagnostics,
    appVersion: truncateString(diagnostics.appVersion, stringLimit),
    channel: truncateString(diagnostics.channel, stringLimit),
    platform: truncateString(String(diagnostics.platform), stringLimit),
    osVersion: truncateString(diagnostics.osVersion, stringLimit),
    arch: truncateString(diagnostics.arch, stringLimit),
    electronVersion: truncateString(diagnostics.electronVersion, stringLimit),
    locale: truncateString(diagnostics.locale, stringLimit),
    route: truncateString(diagnostics.route, stringLimit),
    directory: diagnostics.directory === null ? null : truncateString(diagnostics.directory, stringLimit),
    sessionID: diagnostics.sessionID === null ? null : truncateString(diagnostics.sessionID, stringLimit),
    logPath: truncateString(diagnostics.logPath, stringLimit),
  }
}

export function buildProblemReport(input: Input, options: Options = {}) {
  const maxBytes = Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES)
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive finite number")
  let diagnostics = input.diagnostics
  let logTail = input.logTail
  let messages = sessionMessages(input.sessionExport)
  let sessionInfo = input.sessionExport.status === "ok" ? input.sessionExport.info : undefined
  let omittedMessages = 0
  let omittedLogBytes = 0
  let omittedSessionInfoBytes = 0
  let omittedDiagnosticsBytes = 0

  const makePayload = (): Payload => ({
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    diagnostics,
    logTail,
    sessionExport: withMessages(withSessionInfo(input.sessionExport, sessionInfo), messages),
    truncation: {
      omittedMessages,
      omittedLogBytes,
      omittedSessionInfoBytes,
      omittedDiagnosticsBytes,
    },
  })

  let output = markdown(makePayload())

  while (bytes(output) > maxBytes && messages.length > 0) {
    const remove = Math.max(1, Math.ceil(messages.length / 2))
    omittedMessages += remove
    messages = messages.slice(remove)
    output = markdown(makePayload())
  }

  while (bytes(output) > maxBytes && logTail.length > 0) {
    const remove = Math.max(1, Math.ceil(logTail.length / 2))
    omittedLogBytes += bytes(logTail.slice(0, remove))
    logTail = logTail.slice(remove)
    output = markdown(makePayload())
  }

  if (bytes(output) > maxBytes && input.sessionExport.status === "ok" && sessionInfo !== null) {
    omittedSessionInfoBytes += jsonBytes(sessionInfo)
    sessionInfo = null
    output = markdown(makePayload())
  }

  let diagnosticStringLimit = 512
  while (bytes(output) > maxBytes && diagnosticStringLimit >= 0) {
    diagnostics = truncateDiagnostics(input.diagnostics, diagnosticStringLimit)
    omittedDiagnosticsBytes = Math.max(0, jsonBytes(input.diagnostics) - jsonBytes(diagnostics))
    output = markdown(makePayload())
    if (diagnosticStringLimit === 0) break
    diagnosticStringLimit = Math.floor(diagnosticStringLimit / 2)
  }

  if (bytes(output) > maxBytes) {
    throw new Error("Problem report exceeds maxBytes after truncation")
  }

  return { markdown: output }
}

export function parseProblemReportPayload(input: string): Payload {
  const match = input.match(/```json\r?\n([\s\S]*?)\r?\n```/)
  if (!match) throw new Error("Problem report JSON block not found")
  return JSON.parse(match[1]) as Payload
}
