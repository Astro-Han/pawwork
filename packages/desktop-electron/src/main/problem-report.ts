// Bound full report payloads while preserving recent logs and session snippets for diagnosis.
// Default full report payload limit: 5 MB.
import type { RendererErrorDetails } from "@opencode-ai/app/desktop-api"
import type { RendererDiagnosticEvent, RendererDiagnosticsSlice } from "./renderer-diagnostics"
import {
  type JsonValue,
  makeRedactor,
  type Redactor,
  redactJsonValue,
  sanitizeSessionInfo,
  sanitizeSessionMessages,
  toJsonSafe,
} from "./problem-report-redact"

export const DEFAULT_PROBLEM_REPORT_MAX_BYTES = 5 * 1024 * 1024
const SUMMARY_ERROR_LINE_MAX_CHARS = 220
const SUMMARY_FAILURE_REASON_MAX_CHARS = 80
const SUMMARY_ROUTE_MAX_CHARS = 120
const SUMMARY_SESSION_MAX_CHARS = 80
const SUMMARY_RENDERER_ERROR_MAX_CHARS = 220

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

type SafeSessionExport =
  | { status: "none" }
  | { status: "failed"; error: string }
  | { status: "ok"; info: JsonValue; messages: JsonValue[] }

type Input = {
  diagnostics: ProblemReportDiagnostics
  logTail: string
  sessionExport: SessionExport
  rendererDiagnostics?: RendererDiagnosticsSlice
  rendererError?: RendererErrorDetails
}

type Options = {
  maxBytes?: number
  reportId?: string
  generatedAt?: string
  // Exact strings (OS username, home directory) the caller knows are sensitive at runtime but
  // no regex can infer. Redacted verbatim wherever they appear in the report.
  redactTerms?: string[]
}

type Payload = {
  reportVersion: 1
  reportId: string
  generatedAt: string
  diagnostics: ProblemReportDiagnostics
  logTail: string
  rendererError?: RendererErrorDetails
  rendererDiagnostics?: RendererDiagnosticsSlice
  sessionExport: SafeSessionExport
  truncation: {
    omittedMessages: number
    omittedLogBytes: number
    omittedSessionInfoBytes: number
    omittedFailedExportErrorBytes: number
    omittedRendererDiagnosticsBytes: number
    omittedDiagnosticsBytes: number
  }
}

function bytes(value: string) {
  return Buffer.byteLength(value, "utf8")
}

function isCanonicalIsoTimestamp(value: string) {
  const time = Date.parse(value)
  return !Number.isNaN(time) && new Date(time).toISOString() === value
}

export function defaultReportId() {
  return `pwr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function jsonBytes(value: unknown) {
  return bytes(JSON.stringify(toJsonSafe(value)) ?? "")
}

function markdown(payload: Payload) {
  return [
    "# PawWork Problem Report",
    "",
    "Upload this markdown file to the feedback form after reviewing it.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    "",
  ].join("\n")
}

function sessionMessages(sessionExport: SafeSessionExport): JsonValue[] {
  return sessionExport.status === "ok" ? sessionExport.messages : []
}

function withMessages(sessionExport: SafeSessionExport, messages: JsonValue[]): SafeSessionExport {
  if (sessionExport.status !== "ok") return sessionExport
  return { ...sessionExport, messages }
}

function withSessionInfo(sessionExport: SafeSessionExport, info: JsonValue): SafeSessionExport {
  if (sessionExport.status !== "ok") return sessionExport
  return { ...sessionExport, info }
}

function withFailedExportError(sessionExport: SafeSessionExport, error: string | undefined): SafeSessionExport {
  if (sessionExport.status !== "failed") return sessionExport
  return { ...sessionExport, error: error ?? "" }
}

function sanitizeSessionExport(sessionExport: SessionExport, redact: Redactor): SafeSessionExport {
  if (sessionExport.status === "none") return sessionExport
  if (sessionExport.status === "failed") return { status: "failed", error: redact(sessionExport.error) }
  return {
    status: "ok",
    info: sanitizeSessionInfo(sessionExport.info, { redact }),
    messages: sanitizeSessionMessages(sessionExport.messages, { redact }),
  }
}

// Redact a value that should be text but, coming from the untyped IPC boundary, might not be. A
// non-string is JSON-serialized (deep-scrubbed first) so a secret nested in a stray object value is
// still removed rather than passed through by redact()'s non-string no-op.
function redactField(value: unknown, redact: Redactor): string {
  if (typeof value === "string") return redact(value)
  return redact(JSON.stringify(redactJsonValue(toJsonSafe(value), redact)) ?? "")
}

function redactDiagnostics(diagnostics: ProblemReportDiagnostics, redact: Redactor): ProblemReportDiagnostics {
  return {
    ...diagnostics,
    route: redact(diagnostics.route),
    // directory and logPath are known to be filesystem paths: shape-token them wholesale instead of
    // letting the free-text scrubber guess (it only catches allowlisted roots, so a path under a
    // non-listed root would leak the project/dir name). Empty/null stay as-is so "no path" reads true.
    directory: diagnostics.directory ? "[path]" : diagnostics.directory,
    sessionID: diagnostics.sessionID === null ? null : redact(diagnostics.sessionID),
    logPath: diagnostics.logPath ? "[path]" : diagnostics.logPath,
  }
}

// Renderer diagnostics pass a strict upstream allowlist, but that allowlist keeps trace/session IDs
// and `data` as plain strings without stripping emails, paths, or secrets. Run the structured
// redactor over the WHOLE event (every top-level string field AND every data key/value), so the
// renderer slice carries the same redaction guarantee the rest of the report has. event.name (used
// later for incident filtering) is an enum the redactor leaves untouched.
function redactRendererDiagnostics(slice: RendererDiagnosticsSlice, redact: Redactor): RendererDiagnosticsSlice {
  return {
    ...slice,
    events: slice.events.map((event) => redactJsonValue(toJsonSafe(event), redact) as RendererDiagnosticEvent),
    // summary.statuses is a fixed enum on the production path, but scrub it too so the guarantee
    // covers the whole slice, not only events.
    summary: redactJsonValue(toJsonSafe(slice.summary), redact) as RendererDiagnosticsSlice["summary"],
  }
}

function isProtectedRendererDiagnosticEvent(event: RendererDiagnosticEvent) {
  return event["event.name"].startsWith("incident.") || event["event.name"] === "session.identity.transition"
}

function withRendererDiagnosticsEvents(
  rendererDiagnostics: RendererDiagnosticsSlice,
  events: RendererDiagnosticEvent[],
  omittedBytes: number,
): RendererDiagnosticsSlice {
  const omittedEventCount = rendererDiagnostics.events.length - events.length
  return {
    ...rendererDiagnostics,
    status: omittedEventCount > 0 ? "truncated" : rendererDiagnostics.status,
    events,
    summary: {
      ...rendererDiagnostics.summary,
      event_count: events.length,
      incident_count: events.filter((event) => event["event.name"].startsWith("incident.")).length,
      omitted_event_count: rendererDiagnostics.summary.omitted_event_count + omittedEventCount,
      omitted_bytes: rendererDiagnostics.summary.omitted_bytes + omittedBytes,
      statuses: Array.from(
        new Set([
          ...rendererDiagnostics.summary.statuses,
          ...(omittedEventCount > 0 ? (["truncated"] as const) : []),
        ]),
      ),
    },
  }
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
  const maxBytes = Math.floor(options.maxBytes ?? DEFAULT_PROBLEM_REPORT_MAX_BYTES)
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive finite number")
  const reportId = options.reportId ?? defaultReportId()
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  if (reportId.trim().length === 0) throw new Error("reportId must be a non-empty string")
  if (!isCanonicalIsoTimestamp(generatedAt)) throw new Error("generatedAt must be a valid ISO timestamp")
  // Redact before truncation: cutting first could split a secret across the boundary, and the
  // ladder only ever drops or shortens already-redacted data.
  const redact = makeRedactor(options.redactTerms)
  const sessionExport = sanitizeSessionExport(input.sessionExport, redact)
  const redactedDiagnostics = redactDiagnostics(input.diagnostics, redact)
  let diagnostics = redactedDiagnostics
  let logTail = redact(input.logTail)
  let messages = sessionMessages(sessionExport)
  let sessionInfo = sessionExport.status === "ok" ? sessionExport.info : undefined
  let failedExportError = sessionExport.status === "failed" ? sessionExport.error : undefined
  let rendererDiagnostics = input.rendererDiagnostics
    ? redactRendererDiagnostics(input.rendererDiagnostics, redact)
    : undefined
  let rendererError = input.rendererError
    ? // Construct from the two known fields only — never spread the IPC input, which is untyped at
      // the boundary and could carry extra unredacted fields. Each field is coerced through the
      // redactor as text even when the runtime value is not a string (redact() no-ops on non-strings,
      // so a stray object value would otherwise pass un-scrubbed).
      { summary: redactField(input.rendererError.summary, redact), details: redactField(input.rendererError.details, redact) }
    : undefined
  let omittedMessages = 0
  let omittedLogBytes = 0
  let omittedSessionInfoBytes = 0
  let omittedFailedExportErrorBytes = 0
  let omittedRendererDiagnosticsBytes = 0
  let omittedDiagnosticsBytes = 0

  const makePayload = (): Payload => ({
    reportVersion: 1,
    reportId,
    generatedAt,
    diagnostics,
    logTail,
    ...(rendererError ? { rendererError } : {}),
    ...(rendererDiagnostics ? { rendererDiagnostics } : {}),
    sessionExport: withFailedExportError(
      withMessages(withSessionInfo(sessionExport, sessionInfo ?? null), messages),
      failedExportError,
    ),
    truncation: {
      omittedMessages,
      omittedLogBytes,
      omittedSessionInfoBytes,
      omittedFailedExportErrorBytes,
      omittedRendererDiagnosticsBytes,
      omittedDiagnosticsBytes,
    },
  })

  let output = markdown(makePayload())

  // Drop older entries first so the report keeps the most recent context around the failure.
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

  if (bytes(output) > maxBytes && sessionExport.status === "ok" && sessionInfo != null) {
    omittedSessionInfoBytes += jsonBytes(sessionInfo)
    sessionInfo = null
    output = markdown(makePayload())
  }

  if (bytes(output) > maxBytes && failedExportError !== undefined) {
    const originalError = failedExportError
    let errorLimit = Math.max(0, Math.floor(originalError.length / 2))
    while (bytes(output) > maxBytes && errorLimit >= 0) {
      failedExportError = truncateString(originalError, errorLimit)
      omittedFailedExportErrorBytes = Math.max(0, bytes(originalError) - bytes(failedExportError))
      output = markdown(makePayload())
      if (errorLimit === 0) break
      errorLimit = Math.floor(errorLimit / 2)
    }
  }

  if (bytes(output) > maxBytes && rendererError) {
    const originalDetails = rendererError.details
    let detailsLimit = Math.max(0, Math.floor(originalDetails.length / 2))
    while (bytes(output) > maxBytes && detailsLimit >= 0) {
      rendererError = {
        ...rendererError,
        details: truncateString(originalDetails, detailsLimit),
      }
      output = markdown(makePayload())
      if (detailsLimit === 0) break
      detailsLimit = Math.floor(detailsLimit / 2)
    }
  }

  if (bytes(output) > maxBytes && rendererError) {
    rendererError = undefined
    output = markdown(makePayload())
  }

  if (bytes(output) > maxBytes && rendererDiagnostics) {
    const original = rendererDiagnostics
    let events = [...original.events]
    while (bytes(output) > maxBytes && events.length > 0) {
      const removeIndex = events.findIndex((event) => !isProtectedRendererDiagnosticEvent(event))
      if (removeIndex < 0) break
      events.splice(removeIndex, 1)
      omittedRendererDiagnosticsBytes = Math.max(0, jsonBytes(original.events) - jsonBytes(events))
      rendererDiagnostics = withRendererDiagnosticsEvents(original, events, omittedRendererDiagnosticsBytes)
      output = markdown(makePayload())
    }
  }

  let diagnosticStringLimit = 512
  while (bytes(output) > maxBytes && diagnosticStringLimit >= 0) {
    diagnostics = truncateDiagnostics(redactedDiagnostics, diagnosticStringLimit)
    omittedDiagnosticsBytes = Math.max(0, jsonBytes(redactedDiagnostics) - jsonBytes(diagnostics))
    output = markdown(makePayload())
    if (diagnosticStringLimit === 0) break
    diagnosticStringLimit = Math.floor(diagnosticStringLimit / 2)
  }

  if (bytes(output) > maxBytes) {
    throw new Error("Problem report exceeds maxBytes after truncation")
  }

  return { markdown: output, reportId, generatedAt }
}

type ProblemReportSummaryInput = {
  reportId: string
  generatedAt: string
  diagnostics: ProblemReportDiagnostics
  reportFileName: string | null
  reportLocationHint: string | null
  fullReportStatus: "ready" | "failed"
  failureReason?: string
  recentErrors: string[]
  rendererError?: RendererErrorDetails
  rendererDiagnostics?: RendererDiagnosticsSlice
  // Exact strings (OS username, home directory) the caller knows are sensitive at runtime but no
  // regex can infer. The summary is the same outbound channel as the full report, so it must share
  // these terms — otherwise a bare username or non-allowlisted home leaks through recentErrors.
  redactTerms?: string[]
}

function oneLine(value: string) {
  return (value.split(/\r?\n/)[0] ?? "").replace(/\s+/g, " ").trim()
}

// The clipboard summary is the same outbound channel as the report file, so it gets the full
// secret scrubber too. Path/storage fragments run first (keeps the [storage] .dat shape), then the
// caller's redactor strips tokens, Bearer/basic-auth, emails, AND the exact runtime terms (OS
// username, home directory) the old module-level redactor missed.
function redactLocalPathFragments(value: string, redact: Redactor) {
  return redact(
    value
      .replace(/[A-Za-z]:\\[^\r\n]*/g, "[path]")
      .replace(/\\\\[^\\\s]+\\[^\r\n]*/g, "[path]")
      .replace(/\/(?:Users|home|tmp|var\/folders|private\/tmp)\/[^\r\n]*/g, "[path]")
      .replace(/\bpawwork\.workspace\.[\w.-]+\.dat\b/gi, "[storage]")
      .replace(/\b(storage|key)\s*=\s*[^,\s]+/gi, "$1=[redacted]"),
  )
}

function truncateSummaryLine(value: string, maxChars: number) {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value
}

function safeSummaryRoute(route: string, redact: Redactor) {
  const pathOnly = oneLine(route).split(/[?#]/)[0] || "/"
  return truncateSummaryLine(redactLocalPathFragments(pathOnly, redact), SUMMARY_ROUTE_MAX_CHARS)
}

function safeSummarySession(sessionID: string | null, redact: Redactor) {
  if (sessionID === null) return "none"
  return truncateSummaryLine(oneLine(redactLocalPathFragments(sessionID, redact)), SUMMARY_SESSION_MAX_CHARS)
}

function safeFailureReason(value: string | undefined, redact: Redactor) {
  if (!value) return "unknown"
  return truncateSummaryLine(oneLine(redactLocalPathFragments(value, redact)), SUMMARY_FAILURE_REASON_MAX_CHARS)
}

function summaryRecentErrors(recentErrors: string[], redact: Redactor) {
  const lines = recentErrors
    .map((line) => truncateSummaryLine(oneLine(redactLocalPathFragments(line, redact)), SUMMARY_ERROR_LINE_MAX_CHARS))
    .filter(Boolean)
    .slice(0, 10)
  return lines.length > 0 ? lines : ["No recent errors found"]
}

function safeRendererErrorSummary(rendererError: RendererErrorDetails | undefined, redact: Redactor) {
  if (!rendererError?.summary) return
  return truncateSummaryLine(
    oneLine(redactLocalPathFragments(rendererError.summary, redact)),
    SUMMARY_RENDERER_ERROR_MAX_CHARS,
  )
}

export function buildProblemReportSummary(input: ProblemReportSummaryInput) {
  const redact = makeRedactor(input.redactTerms)
  const rendererError = safeRendererErrorSummary(input.rendererError, redact)
  const fullReportLines =
    input.fullReportStatus === "ready"
      ? [
          "Full report: ready for manual upload",
          // saveReport's filename/hint are not trusted to be identity-free — run them through the
          // same path-fragment + term scrubber as the rest of the summary, not raw into the clipboard.
          `Report file: ${redactLocalPathFragments(input.reportFileName ?? "unknown", redact)}`,
          `Report location: ${redactLocalPathFragments(input.reportLocationHint ?? "unknown", redact)}`,
        ]
      : [
          "Full report: not generated",
          `Full report failure: ${safeFailureReason(input.failureReason, redact)}`,
          "Submit this summary without an attachment if needed.",
        ]

  return [
    "PawWork Problem Report Summary",
    "",
    `Report ID: ${input.reportId}`,
    `Generated: ${input.generatedAt}`,
    `PawWork: ${input.diagnostics.appVersion} (${input.diagnostics.channel})`,
    `Platform: ${input.diagnostics.platform} ${input.diagnostics.osVersion} ${input.diagnostics.arch}`,
    `Electron: ${input.diagnostics.electronVersion}`,
    `Route: ${safeSummaryRoute(input.diagnostics.route, redact)}`,
    `Session: ${safeSummarySession(input.diagnostics.sessionID, redact)}`,
    ...(input.rendererDiagnostics
      ? [
          `Renderer diagnostics: ${input.rendererDiagnostics.status}, events=${input.rendererDiagnostics.summary.event_count}, incidents=${input.rendererDiagnostics.summary.incident_count}`,
        ]
      : []),
    ...(rendererError ? [`Renderer error: ${rendererError}`] : []),
    ...fullReportLines,
    "",
    "Recent key errors:",
    ...summaryRecentErrors(input.recentErrors, redact).map((line) => `- ${line}`),
    "",
  ].join("\n")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isDiagnostics(value: unknown): value is ProblemReportDiagnostics {
  if (!isRecord(value)) return false
  return (
    typeof value.appVersion === "string" &&
    typeof value.channel === "string" &&
    typeof value.packaged === "boolean" &&
    typeof value.updaterEnabled === "boolean" &&
    typeof value.platform === "string" &&
    typeof value.osVersion === "string" &&
    typeof value.arch === "string" &&
    typeof value.electronVersion === "string" &&
    typeof value.locale === "string" &&
    typeof value.route === "string" &&
    isStringOrNull(value.directory) &&
    isStringOrNull(value.sessionID) &&
    typeof value.logPath === "string"
  )
}

function isSessionExport(value: unknown): value is SessionExport {
  if (!isRecord(value) || typeof value.status !== "string") return false
  if (value.status === "none") return true
  if (value.status === "failed") return typeof value.error === "string"
  if (value.status === "ok") return "info" in value && Array.isArray(value.messages)
  return false
}

function isRendererErrorDetails(value: unknown): value is RendererErrorDetails {
  return isRecord(value) && typeof value.summary === "string" && typeof value.details === "string"
}

function isRendererDiagnosticsSlice(value: unknown): value is RendererDiagnosticsSlice {
  if (!isRecord(value)) return false
  if (typeof value.status !== "string" || value.source !== "renderer-diagnostics") return false
  if (typeof value.generated_at !== "string" || !Array.isArray(value.events)) return false
  if (!isRecord(value.summary)) return false
  return (
    isFiniteNumber(value.summary.event_count) &&
    isFiniteNumber(value.summary.incident_count) &&
    Array.isArray(value.summary.statuses) &&
    isFiniteNumber(value.summary.omitted_event_count) &&
    isFiniteNumber(value.summary.omitted_bytes)
  )
}

function isTruncation(value: unknown): value is Payload["truncation"] {
  if (!isRecord(value)) return false
  return (
    isFiniteNumber(value.omittedMessages) &&
    isFiniteNumber(value.omittedLogBytes) &&
    isFiniteNumber(value.omittedSessionInfoBytes) &&
    isFiniteNumber(value.omittedFailedExportErrorBytes) &&
    isFiniteNumber(value.omittedRendererDiagnosticsBytes) &&
    isFiniteNumber(value.omittedDiagnosticsBytes)
  )
}

function isProblemReportPayload(value: unknown): value is Payload {
  if (!isRecord(value)) return false
  return (
    value.reportVersion === 1 &&
    typeof value.reportId === "string" &&
    value.reportId.length > 0 &&
    typeof value.generatedAt === "string" &&
    !Number.isNaN(Date.parse(value.generatedAt)) &&
    isDiagnostics(value.diagnostics) &&
    typeof value.logTail === "string" &&
    (value.rendererError === undefined || isRendererErrorDetails(value.rendererError)) &&
    (value.rendererDiagnostics === undefined || isRendererDiagnosticsSlice(value.rendererDiagnostics)) &&
    isSessionExport(value.sessionExport) &&
    isTruncation(value.truncation)
  )
}

export function parseProblemReportPayload(input: string): Payload {
  const lines = input.split(/\r?\n/)
  for (let start = 0; start < lines.length; start++) {
    if (lines[start] !== "```json") continue
    for (let end = start + 1; end < lines.length; end++) {
      if (lines[end] !== "```") continue
      try {
        const parsed = JSON.parse(lines.slice(start + 1, end).join("\n")) as unknown
        if (isProblemReportPayload(parsed)) return parsed
      } catch {
        continue
      }
    }
  }

  throw new Error("Problem report JSON block not found")
}
