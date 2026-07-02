// Bound full report payloads while preserving recent logs and session snippets for diagnosis.
// Default full report payload limit: 5 MB.
import type { RendererErrorDetails } from "@opencode-ai/app/desktop-api"
import type { RendererDiagnosticEvent, RendererDiagnosticsSlice } from "./renderer-diagnostics"
import { capEvents, SESSION_EXPORT_RENDERER_DIAGNOSTICS_MAX_BYTES } from "./renderer-diagnostics"
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
const PROBLEM_REPORT_VERSION = 2

// Per-component byte budgets. Each source is bounded independently so one component (a giant log, a
// long session, a huge renderer stack) can't fill the whole report and crowd out the rest. They sum
// to well under DEFAULT_PROBLEM_REPORT_MAX_BYTES, leaving the overall maxBytes ladder below as a
// final fallback rather than the primary bound.
// Fixed, not configurable — there is no production caller that would tune these, so they are not a
// public API surface. The capping logic is exercised in tests by calling the pure cap helpers
// (capLogTailBytes / capMessageParts / capSessionMessagesBytes / headBytes / capEvents) directly with
// small limits.
const COMPONENT_BUDGETS = {
  logTailBytes: 1 * 1024 * 1024,
  sessionMessagesBytes: 1 * 1024 * 1024,
  // Per single message, so one long turn (many tool parts) can't consume the whole session budget.
  sessionMessageBytes: 256 * 1024,
  // Per renderer-error text field. Bounds BOTH summary and details: summary derives from
  // error.message, which an API error can balloon, so capping only details would leave a hole.
  rendererErrorDetailsBytes: 64 * 1024,
  // Renderer diagnostics are byte-capped at the source (when the slice is built), but redaction here
  // can re-expand them, so re-bound to the same ceiling after redaction — same capEvents() ruler.
  rendererDiagnosticsBytes: SESSION_EXPORT_RENDERER_DIAGNOSTICS_MAX_BYTES,
}

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
  meta: {
    reportVersion: typeof PROBLEM_REPORT_VERSION
    reportId: string
    generatedAt: string
    truncation: {
      omittedMessages: number
      omittedMessagePartsBytes: number
      omittedLogBytes: number
      omittedSessionInfoBytes: number
      omittedFailedExportErrorBytes: number
      omittedRendererErrorBytes: number
      omittedRendererDiagnosticsBytes: number
      omittedDiagnosticsBytes: number
    }
  }
  environment: ProblemReportDiagnostics
  error: RendererErrorDetails | null
  recentErrors: string[]
  session: SafeSessionExport
  rendererDiagnostics: RendererDiagnosticsSlice | null
  logTail: string[]
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

// Keep the leading maxBytes bytes of a string, backing off so a multibyte char is never split.
export function headBytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8")
  if (buffer.length <= maxBytes) return value
  let end = maxBytes
  // 0b10xxxxxx are UTF-8 continuation bytes; step back until end sits on a char boundary.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--
  return buffer.toString("utf8", 0, end)
}

// Keep the trailing <= maxBytes bytes of a string, advancing to the next char boundary so the result
// never starts mid-character (which would yield a replacement char and re-encode larger than maxBytes).
function tailBytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8")
  if (buffer.length <= maxBytes) return value
  let start = buffer.length - maxBytes
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
  return buffer.toString("utf8", start)
}

// Keep the most-recent bytes of a log, cutting whole lines off the front so the top is never a
// fragment of an older line. Falls back to a hard byte cut only for a single oversized line.
export function capLogTailBytes(value: string, maxBytes: number): { value: string; omittedBytes: number } {
  const total = bytes(value)
  if (total <= maxBytes) return { value, omittedBytes: 0 }
  const lines = value.split("\n")
  let acc = 0
  let startIndex = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    // +1 for the "\n" joining this line to the already-kept block (every kept line except the last).
    const add = bytes(lines[i]) + (i < lines.length - 1 ? 1 : 0)
    if (acc + add > maxBytes && startIndex < lines.length) break
    acc += add
    startIndex = i
  }
  let out = startIndex < lines.length ? lines.slice(startIndex).join("\n") : ""
  // Whole-line selection kept nothing useful — the most recent line alone exceeds the budget, with or
  // without a trailing newline (which leaves an empty last "line"). Fall back to a byte-accurate tail
  // of the original so the report still carries the most recent bytes rather than an empty string.
  if (out === "" || bytes(out) > maxBytes) out = tailBytes(value, maxBytes)
  return { value: out, omittedBytes: Math.max(0, total - bytes(out)) }
}

// Reduce a message whose info alone exceeds the budget to an identity stub, so even a pathological
// message — a malformed time/tokens blob, hundreds of parts, or an oversized id — can never break the
// session budget. id/role are byte-capped too (they are normally short, but the IPC boundary is
// untyped), bounding the stub to a small constant. The oversized marker keeps the reduction visible.
const STUB_IDENTITY_MAX_BYTES = 256
function messageIdentityStub(record: { [key: string]: JsonValue }, omittedParts: number): JsonValue {
  const info = isRecord(record.info) ? record.info : {}
  const stub: { [key: string]: JsonValue } = {}
  if (typeof info.id === "string") stub.id = headBytes(info.id, STUB_IDENTITY_MAX_BYTES)
  if (typeof info.role === "string") stub.role = headBytes(info.role, STUB_IDENTITY_MAX_BYTES)
  return { info: stub, parts: [], omittedParts, oversized: true }
}

// Trim a single message's leading parts so its JSON fits the per-message budget, leaving an
// omittedParts marker. Keeps the message info and the LATEST parts (the end of the turn — the tool
// output / error nearest the failure), matching the rest of the ladder, which drops oldest-first to
// keep the most recent context. This bounds any one message so the newest message — always kept by
// capSessionMessagesBytes below — can never blow the session budget on its own.
export function capMessageParts(message: JsonValue, maxBytes: number): { value: JsonValue; omittedBytes: number } {
  if (!isRecord(message)) return { value: message, omittedBytes: 0 }
  const record = message as { [key: string]: JsonValue }
  const original = jsonBytes(message)
  const parts = record.parts
  const partCount = Array.isArray(parts) ? parts.length : 0
  if (original <= maxBytes) return { value: message, omittedBytes: 0 }
  const done = (value: JsonValue) => ({ value, omittedBytes: Math.max(0, original - jsonBytes(value)) })
  // No parts to trim — only the info is left, and it already overflows: stub it.
  if (!Array.isArray(parts) || parts.length === 0) return done(messageIdentityStub(record, partCount))
  // Binary-search the largest trailing run of parts that fits, so this stays O(log n) JSON renders.
  let lo = 0
  let hi = parts.length
  let kept = 0
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const candidate = { ...record, parts: parts.slice(parts.length - mid), omittedParts: parts.length - mid }
    if (jsonBytes(candidate) <= maxBytes) {
      kept = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const trimmed = { ...record, parts: parts.slice(parts.length - kept), omittedParts: parts.length - kept }
  // Even zero parts didn't fit: the info itself is oversized. Reduce to an identity stub.
  return done(jsonBytes(trimmed) <= maxBytes ? trimmed : messageIdentityStub(record, parts.length))
}

// Drop oldest messages (from the front) until the array's JSON fits, keeping the most recent context
// around the failure. This is a hard cap: a message that does not fit is dropped even if it is the
// newest, so the kept set never exceeds maxBytes. capMessageParts has already bounded each message to
// the per-message budget (a ≤256-byte identity stub at worst), so under any realistic budget the newest
// message always fits and the latest turn survives; only a pathologically tiny budget yields an empty
// set — the correct outcome for a near-zero budget.
export function capSessionMessagesBytes(
  messages: JsonValue[],
  maxBytes: number,
): { messages: JsonValue[]; omittedMessages: number } {
  if (jsonBytes(messages) <= maxBytes) return { messages, omittedMessages: 0 }
  const sizes = messages.map((message) => jsonBytes(message))
  let acc = 2 // "[]" framing
  let keptCount = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const add = sizes[i] + (keptCount > 0 ? 1 : 0) // +1 for the joining comma
    if (acc + add > maxBytes) break
    acc += add
    keptCount++
  }
  return {
    messages: messages.slice(messages.length - keptCount),
    omittedMessages: messages.length - keptCount,
  }
}

function jsonReport(payload: Payload) {
  return JSON.stringify(payload, null, 2)
}

function logLines(value: string) {
  return value.length > 0 ? value.split(/\r?\n/) : []
}

export function recentKeyErrors(value: string) {
  return logLines(value)
    .filter((line) => /\b(error|warn|warning|failed|exception)\b/i.test(line))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-10)
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
  // Immutable post-redaction baseline. Every renderer-diagnostics cap (the component budget below and
  // the overall ladder) re-derives from this, so the omitted ledger stays correct across stages.
  const redactedRendererDiagnostics = rendererDiagnostics
  let rendererError = input.rendererError
    ? // Construct from the two known fields only — never spread the IPC input, which is untyped at
      // the boundary and could carry extra unredacted fields. Each field is coerced through the
      // redactor as text even when the runtime value is not a string (redact() no-ops on non-strings,
      // so a stray object value would otherwise pass un-scrubbed).
      { summary: redactField(input.rendererError.summary, redact), details: redactField(input.rendererError.details, redact) }
    : undefined
  // Baseline of the redacted renderer-error text (summary + details) before any capping.
  // omittedRendererErrorBytes is derived from this in makePayload, so it stays correct no matter which
  // stage (component budget, overall ladder truncation, or full removal) shrinks either field.
  const rendererErrorBaseline = rendererError ? bytes(rendererError.summary) + bytes(rendererError.details) : 0
  let omittedMessages = 0
  // Bytes removed from WITHIN surviving messages by capMessageParts — trailing parts trimmed, or an
  // oversized message reduced to an identity stub (which also drops its parts). Distinct from
  // omittedMessages, which counts whole messages dropped to fit the session budget.
  let omittedMessagePartsBytes = 0
  let omittedLogBytes = 0
  let omittedSessionInfoBytes = 0
  let omittedFailedExportErrorBytes = 0
  let omittedRendererDiagnosticsBytes = 0
  let omittedDiagnosticsBytes = 0

  // Bound the renderer-diagnostics events to a byte budget using the same capEvents() as the source
  // slice (drops non-incident events first, then incidents only if a single payload still overflows).
  // Re-derives from the redacted baseline each call, so it is idempotent across the component-budget
  // pass and the overall ladder, and the omitted ledger always reflects the total dropped from baseline.
  const baselineRendererEvents = redactedRendererDiagnostics?.events ?? []
  const baselineRendererEventsBytes = jsonBytes(baselineRendererEvents)
  const capRendererDiagnostics = (maxEventBytes: number) => {
    if (!redactedRendererDiagnostics) return
    const capped = capEvents(baselineRendererEvents, maxEventBytes)
    omittedRendererDiagnosticsBytes = Math.max(0, baselineRendererEventsBytes - jsonBytes(capped.events))
    rendererDiagnostics =
      capped.omittedEventCount > 0
        ? withRendererDiagnosticsEvents(redactedRendererDiagnostics, capped.events, omittedRendererDiagnosticsBytes)
        : redactedRendererDiagnostics
  }

  // Per-component budgets: bound each source independently so one can't dominate the report. Runs
  // after redaction (cuts never split a secret) and before the overall maxBytes ladder, which is now
  // the fallback. Keeps the most recent context (log tail, latest messages) around the failure.
  const budgets = COMPONENT_BUDGETS
  const cappedLog = capLogTailBytes(logTail, budgets.logTailBytes)
  logTail = cappedLog.value
  omittedLogBytes += cappedLog.omittedBytes
  // Bound each message first (trim parts of an oversized single turn), then drop oldest whole messages
  // to the total budget — so neither one huge message nor many messages can dominate. The per-message
  // budget never exceeds the total, so the kept set honors the session budget. survivorPartTrimBytes
  // stays aligned with `messages` (oldest first) as both the session cap here and the overall ladder
  // below drop from the front, so omittedMessagePartsBytes counts only part-trim of messages that
  // actually remain — a message dropped whole is represented by omittedMessages, never double-counted.
  const perMessageBudget = Math.min(budgets.sessionMessageBytes, budgets.sessionMessagesBytes)
  const partTrimBytes: number[] = []
  messages = messages.map((message) => {
    const capped = capMessageParts(message, perMessageBudget)
    partTrimBytes.push(capped.omittedBytes)
    return capped.value
  })
  const cappedMessages = capSessionMessagesBytes(messages, budgets.sessionMessagesBytes)
  messages = cappedMessages.messages
  omittedMessages += cappedMessages.omittedMessages
  let survivorPartTrimBytes = partTrimBytes.slice(cappedMessages.omittedMessages)
  const sumPartTrim = () => survivorPartTrimBytes.reduce((total, value) => total + value, 0)
  omittedMessagePartsBytes = sumPartTrim()
  if (rendererError) {
    // Cap both text fields: summary (from error.message) is as untrusted as details.
    const summary = headBytes(rendererError.summary, budgets.rendererErrorDetailsBytes)
    const details = headBytes(rendererError.details, budgets.rendererErrorDetailsBytes)
    if (summary.length < rendererError.summary.length || details.length < rendererError.details.length) {
      rendererError = { ...rendererError, summary, details }
    }
  }
  // Re-bound renderer diagnostics post-redaction to their component budget, so a redaction that
  // re-expanded the source-capped slice can't ride into the report above its per-component ceiling.
  if (redactedRendererDiagnostics) capRendererDiagnostics(budgets.rendererDiagnosticsBytes)

  const makePayload = (): Payload => ({
    meta: {
      reportVersion: PROBLEM_REPORT_VERSION,
      reportId,
      generatedAt,
      truncation: {
        omittedMessages,
        omittedMessagePartsBytes,
        omittedLogBytes,
        omittedSessionInfoBytes,
        omittedFailedExportErrorBytes,
        // Derived: whatever the renderer-error text (summary + details) lost across every truncation
        // stage, including full removal.
        omittedRendererErrorBytes: Math.max(
          0,
          rendererErrorBaseline - (rendererError ? bytes(rendererError.summary) + bytes(rendererError.details) : 0),
        ),
        omittedRendererDiagnosticsBytes,
        omittedDiagnosticsBytes,
      },
    },
    environment: diagnostics,
    error: rendererError ?? null,
    recentErrors: recentKeyErrors(logTail),
    session: withFailedExportError(
      withMessages(withSessionInfo(sessionExport, sessionInfo ?? null), messages),
      failedExportError,
    ),
    rendererDiagnostics: rendererDiagnostics ?? null,
    logTail: logLines(logTail),
  })

  let output = jsonReport(makePayload())

  // Drop older entries first so the report keeps the most recent context around the failure.
  while (bytes(output) > maxBytes && messages.length > 0) {
    const remove = Math.max(1, Math.ceil(messages.length / 2))
    omittedMessages += remove
    messages = messages.slice(remove)
    // Keep the part-trim ledger consistent: the dropped messages are no longer in the report.
    survivorPartTrimBytes = survivorPartTrimBytes.slice(remove)
    omittedMessagePartsBytes = sumPartTrim()
    output = jsonReport(makePayload())
  }

  while (bytes(output) > maxBytes && logTail.length > 0) {
    const remove = Math.max(1, Math.ceil(logTail.length / 2))
    omittedLogBytes += bytes(logTail.slice(0, remove))
    logTail = logTail.slice(remove)
    output = jsonReport(makePayload())
  }

  if (bytes(output) > maxBytes && sessionExport.status === "ok" && sessionInfo != null) {
    omittedSessionInfoBytes += jsonBytes(sessionInfo)
    sessionInfo = null
    output = jsonReport(makePayload())
  }

  if (bytes(output) > maxBytes && failedExportError !== undefined) {
    const originalError = failedExportError
    let errorLimit = Math.max(0, Math.floor(originalError.length / 2))
    while (bytes(output) > maxBytes && errorLimit >= 0) {
      failedExportError = truncateString(originalError, errorLimit)
      omittedFailedExportErrorBytes = Math.max(0, bytes(originalError) - bytes(failedExportError))
      output = jsonReport(makePayload())
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
      output = jsonReport(makePayload())
      if (detailsLimit === 0) break
      detailsLimit = Math.floor(detailsLimit / 2)
    }
  }

  if (bytes(output) > maxBytes && rendererError) {
    rendererError = undefined
    output = jsonReport(makePayload())
  }

  // Final backstop: halve the renderer-diagnostics event budget until the report fits. Uses the same
  // capEvents() ruler as above, which can drop even incident events once a tight maxBytes leaves no
  // alternative — so an all-protected oversized slice drains to empty rather than overflowing.
  if (bytes(output) > maxBytes && rendererDiagnostics && rendererDiagnostics.events.length > 0) {
    let limit = Math.max(0, Math.floor(jsonBytes(rendererDiagnostics.events) / 2))
    while (bytes(output) > maxBytes && limit >= 0) {
      capRendererDiagnostics(limit)
      output = jsonReport(makePayload())
      if (limit === 0) break
      limit = Math.floor(limit / 2)
    }
  }

  let diagnosticStringLimit = 512
  while (bytes(output) > maxBytes && diagnosticStringLimit >= 0) {
    diagnostics = truncateDiagnostics(redactedDiagnostics, diagnosticStringLimit)
    omittedDiagnosticsBytes = Math.max(0, jsonBytes(redactedDiagnostics) - jsonBytes(diagnostics))
    output = jsonReport(makePayload())
    if (diagnosticStringLimit === 0) break
    diagnosticStringLimit = Math.floor(diagnosticStringLimit / 2)
  }

  if (bytes(output) > maxBytes) {
    throw new Error("Problem report exceeds maxBytes after truncation")
  }

  return { json: output, reportId, generatedAt }
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isTruncation(value: unknown): value is Payload["meta"]["truncation"] {
  if (!isRecord(value)) return false
  return (
    isFiniteNumber(value.omittedMessages) &&
    isFiniteNumber(value.omittedMessagePartsBytes) &&
    isFiniteNumber(value.omittedLogBytes) &&
    isFiniteNumber(value.omittedSessionInfoBytes) &&
    isFiniteNumber(value.omittedFailedExportErrorBytes) &&
    isFiniteNumber(value.omittedRendererErrorBytes) &&
    isFiniteNumber(value.omittedRendererDiagnosticsBytes) &&
    isFiniteNumber(value.omittedDiagnosticsBytes)
  )
}

function isProblemReportPayload(value: unknown): value is Payload {
  if (!isRecord(value)) return false
  return (
    isRecord(value.meta) &&
    value.meta.reportVersion === PROBLEM_REPORT_VERSION &&
    typeof value.meta.reportId === "string" &&
    value.meta.reportId.length > 0 &&
    typeof value.meta.generatedAt === "string" &&
    !Number.isNaN(Date.parse(value.meta.generatedAt)) &&
    isTruncation(value.meta.truncation) &&
    isDiagnostics(value.environment) &&
    (value.error === null || isRendererErrorDetails(value.error)) &&
    isStringArray(value.recentErrors) &&
    isSessionExport(value.session) &&
    (value.rendererDiagnostics === null || isRendererDiagnosticsSlice(value.rendererDiagnostics)) &&
    isStringArray(value.logTail)
  )
}

export function parseProblemReportPayload(input: string): Payload {
  try {
    const parsed = JSON.parse(input) as unknown
    if (isProblemReportPayload(parsed)) return parsed
  } catch {
    // fall through to the shared error below
  }

  throw new Error("Problem report JSON payload not found")
}
