import { isRecord } from "@/util/record"

export type StreamBoundary = "watchdog" | "local_abort" | "sdk_transport" | "provider_stream" | "unknown"
export type StreamConfidence = "low" | "medium" | "high"
export type StreamEvidence =
  | "watchdog_fired"
  | "watchdog_error"
  | "abort_signal_aborted"
  | "abort_provenance_present"
  | "abort_provenance_missing"
  | "provider_error_event"
  | "iterator_error"
  | "provider_progress_seen"
  | "request_id_present"
  | "provider_correlation_unavailable"

export type BoundaryInput = {
  watchdogFired?: boolean
  watchdogError?: boolean
  abortSignalAborted?: boolean
  abortProvenancePresent?: boolean
  providerErrorEvent?: boolean
  iteratorError?: boolean
  providerProgressSeen?: boolean
  requestIdPresent?: boolean
  providerCorrelationUnavailable?: boolean
}

export type BoundaryResult = {
  boundary: StreamBoundary
  confidence: StreamConfidence
  evidence: StreamEvidence[]
}

export type ProviderCorrelation = {
  request_id?: string
  response_id?: string
  status_code?: number
  safe_headers?: Record<string, string>
  unavailable_reason?: string
}

const SAFE_HEADER_NAMES = new Set(["x-request-id", "request-id", "x-correlation-id", "x-trace-id", "traceparent"])

export function classifyBoundary(input: BoundaryInput): BoundaryResult {
  const evidence: StreamEvidence[] = []
  if (input.watchdogFired) evidence.push("watchdog_fired")
  if (input.watchdogError) evidence.push("watchdog_error")
  if (input.abortSignalAborted) evidence.push("abort_signal_aborted")
  if (input.abortProvenancePresent === true) evidence.push("abort_provenance_present")
  if (input.abortProvenancePresent === false) evidence.push("abort_provenance_missing")
  if (input.providerErrorEvent) evidence.push("provider_error_event")
  if (input.iteratorError) evidence.push("iterator_error")
  if (input.providerProgressSeen) evidence.push("provider_progress_seen")
  if (input.requestIdPresent) evidence.push("request_id_present")
  if (input.providerCorrelationUnavailable) evidence.push("provider_correlation_unavailable")

  if (input.watchdogFired && input.watchdogError) return { boundary: "watchdog", confidence: "high", evidence }
  if (input.abortSignalAborted && input.abortProvenancePresent) {
    return { boundary: "local_abort", confidence: "high", evidence }
  }
  if (input.providerErrorEvent && input.requestIdPresent) {
    return { boundary: "provider_stream", confidence: "high", evidence }
  }
  if (input.providerErrorEvent) return { boundary: "provider_stream", confidence: "medium", evidence }
  if (input.abortSignalAborted && input.iteratorError) return { boundary: "unknown", confidence: "low", evidence }
  if (input.providerProgressSeen && input.iteratorError)
    return { boundary: "sdk_transport", confidence: "low", evidence }
  if (input.iteratorError) return { boundary: "unknown", confidence: "low", evidence }
  return { boundary: "unknown", confidence: "low", evidence }
}

export function safeProviderCorrelation(input: unknown): ProviderCorrelation {
  if (!isRecord(input)) return { unavailable_reason: "provider_correlation_unavailable" }
  const requestID = safeIdentifier(input.request_id ?? input.requestId ?? input["x-request-id"])
  const responseID = safeIdentifier(input.response_id ?? input.responseId)
  const statusCode = typeof input.status_code === "number" ? input.status_code : number(input.statusCode)
  const safeHeaders = safeHeaderMap(input.headers ?? input.safe_headers)
  const result: ProviderCorrelation = {
    ...(requestID ? { request_id: requestID } : {}),
    ...(responseID ? { response_id: responseID } : {}),
    ...(statusCode !== undefined ? { status_code: statusCode } : {}),
    ...(safeHeaders ? { safe_headers: safeHeaders } : {}),
  }
  return Object.keys(result).length ? result : { unavailable_reason: "provider_correlation_unavailable" }
}

export function safeErrorFingerprint(error: unknown) {
  const record = isRecord(error) ? error : undefined
  const cause = record && isRecord(record.cause) ? record.cause : undefined
  return {
    constructor_name: safeLowCardinality(record?.constructor?.name),
    name: safeLowCardinality(record?.name),
    message: safeMessage(record?.message ?? (typeof error === "string" ? error : undefined)),
    code: safeLowCardinality(record?.code),
    cause_constructor_name: safeLowCardinality(cause?.constructor?.name),
    cause_name: safeLowCardinality(cause?.name),
    cause_message: safeMessage(cause?.message),
    cause_code: safeLowCardinality(cause?.code),
    stack_hint: safeStackHint(record?.stack),
  }
}

function safeHeaderMap(value: unknown) {
  if (!isRecord(value)) return undefined
  const result: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase()
    if (!SAFE_HEADER_NAMES.has(name)) continue
    const safeValue = safeIdentifier(rawValue)
    if (!safeValue) continue
    result[name] = safeValue
  }
  return Object.keys(result).length ? result : undefined
}

function safeIdentifier(value: unknown) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 128) return undefined
  if (/https?:\/\//i.test(trimmed)) return undefined
  if (/bearer|cookie|token|secret|sk-/i.test(trimmed)) return undefined
  if (!/^[a-zA-Z0-9_.:\/-]+$/.test(trimmed)) return undefined
  return trimmed
}

function safeLowCardinality(value: unknown) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 80) return undefined
  if (!/^[a-zA-Z0-9_.:-]+$/.test(trimmed)) return undefined
  return trimmed
}

function safeMessage(value: unknown) {
  if (typeof value !== "string") return undefined
  let result = value.slice(0, 1024)
  result = result.replace(/https?:\/\/\S+/gi, "[redacted:url]")
  result = result.replace(/\bsk-[a-zA-Z0-9_-]+\b/g, "[redacted:secret]")
  result = result.replace(/Bearer\s+[a-zA-Z0-9._~+/-]+/gi, "Bearer [redacted:secret]")
  result = result.replace(/\/Users\/[^\s)]+/g, "[redacted:path]")
  result = result.replace(/\\Users\\[^\s)]+/g, "[redacted:path]")
  result = result.replace(/\/home\/[^\s)]+/g, "[redacted:path]")
  return result.slice(0, 1024)
}

function safeStackHint(value: unknown) {
  if (typeof value !== "string") return undefined
  const line = value.split("\n").find((entry) => entry.includes(" at "))
  if (!line) return undefined
  return safeMessage(line)?.slice(0, 160)
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
