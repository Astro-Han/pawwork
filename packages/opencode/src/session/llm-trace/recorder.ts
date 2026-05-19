import type { MessageV2 } from "../message-v2"
import type {
  FinalizeInput,
  Flags,
  Recorder,
  RecorderInput,
  RequestSummary,
  RequestSummaryInput,
  StoredParts,
  StreamEvents,
  Tokens,
} from "./types"
import { SCHEMA_VERSION } from "./types"
import type { StreamDiagnostics } from "./types"
import { classifyBoundary, safeErrorFingerprint, safeProviderCorrelation } from "./stream-diagnostics"

export function requestSummary(input: RequestSummaryInput): RequestSummary {
  const options = safeOptions(input.options)
  return {
    streaming: true,
    tool_count: input.toolCount,
    tool_choice: input.toolChoice,
    small: input.small,
    reasoning_capability: input.reasoningCapability,
    interleaved_field: input.interleavedField,
    ...(options ? { options } : {}),
  }
}

export function createRecorder(input: RecorderInput): Recorder {
  const events = emptyStreamEvents()
  let request: RequestSummary | undefined
  let finishReason: string | undefined
  let tokens: MessageV2.Assistant["tokens"] | undefined
  let stream: StreamDiagnostics | undefined
  let streamMonotonicStart: number | undefined

  return {
    request(summary) {
      request = summary
    },
    observeEvent(event) {
      countEvent(events, event.type)
    },
    finish(reason, nextTokens) {
      finishReason = reason
      tokens = nextTokens
    },
    beginStream(next) {
      streamMonotonicStart = next.monotonicMs
      stream = {
        schema_version: 2,
        legacy_v1_counters: "aggregate",
        timeline: {
          collector_created_at: next.collectorCreatedAt,
        },
        watchdog: {
          connect_timeout_ms: next.connectTimeoutMs,
          stream_timeout_ms: next.streamTimeoutMs,
          provider_progressed: false,
          phase_at_end: "before_first_provider_progress",
          fired: false,
        },
      }
    },
    recordStreamFailure(next) {
      if (!stream) return
      if (stream.error?.boundary === "watchdog" && stream.error.confidence === "high") return
      stream.timeline.failed_at = next.failedAt
      stream.timeline.durations_ms = {
        ...(stream.timeline.durations_ms ?? {}),
        total: durationSince(streamMonotonicStart, next.monotonicMs),
      }
      stream.error = {
        ...safeErrorFingerprint(next.error),
        boundary: next.boundary,
        confidence: next.confidence,
        evidence: next.evidence,
      }
    },
    recordProviderProgress(next) {
      if (!stream) return
      stream.watchdog.provider_progressed = true
      stream.watchdog.phase_at_end = "between_provider_events"
      if (stream.timeline.first_provider_progress_at === undefined) {
        stream.timeline.first_provider_progress_at = next.eventAt
        stream.timeline.durations_ms = {
          ...(stream.timeline.durations_ms ?? {}),
          watchdog_armed_to_first_provider_progress: durationSince(streamMonotonicStart, next.monotonicMs),
        }
      }
      stream.timeline.last_provider_progress_at = next.eventAt
    },
    recordWatchdogFired(next) {
      if (!stream) return
      stream.watchdog.fired = true
      stream.watchdog.fired_phase = next.phase
      if (next.phase === "connect") stream.watchdog.phase_at_end = "before_first_provider_progress"
    },
    recordStreamCompleted(next) {
      if (!stream) return
      stream.timeline.completed_at = next.completedAt
      stream.watchdog.phase_at_end = "completed"
      stream.timeline.durations_ms = {
        ...(stream.timeline.durations_ms ?? {}),
        total: durationSince(streamMonotonicStart, next.monotonicMs),
      }
    },
    recordProviderErrorEvent(next) {
      if (!stream) return
      if (stream.error?.boundary === "watchdog" && stream.error.confidence === "high") return
      const provider = safeProviderCorrelation(next.provider)
      stream.provider = provider
      const boundary = classifyBoundary({
        providerErrorEvent: true,
        iteratorError: true,
        requestIdPresent: provider?.request_id !== undefined || provider?.response_id !== undefined,
        providerCorrelationUnavailable: provider?.unavailable_reason !== undefined,
      })
      stream.timeline.failed_at = next.failedAt
      stream.timeline.durations_ms = {
        ...(stream.timeline.durations_ms ?? {}),
        total: durationSince(streamMonotonicStart, next.monotonicMs),
      }
      stream.error = {
        ...safeErrorFingerprint(next.error),
        boundary: boundary.boundary,
        confidence: boundary.confidence,
        evidence: boundary.evidence,
      }
    },
    recordProviderCorrelation(input) {
      if (!stream) return
      stream.provider = safeProviderCorrelation(input)
    },
    finalize(final: FinalizeInput) {
      const finalFinishReason = final.finishReason ?? finishReason
      const finalTokens = final.tokens ?? tokens
      const stored = storedPartCounts(final.storedParts)
      const flags: Flags = {
        empty_completion: isEmptyCompletion(finalFinishReason, stored),
        ...(final.streamError ? { stream_error: true } : {}),
        ...(final.aborted ? { aborted: true } : {}),
      }
      return {
        schema_version: SCHEMA_VERSION,
        trace_id: input.traceID,
        session_id: input.sessionID,
        message_id: input.messageID,
        parent_message_id: input.parentMessageID,
        provider: input.providerID,
        model: input.modelID,
        agent: input.agent,
        variant: input.variant,
        request: final.request ?? request,
        stream_events: {
          ...events,
          ...(finalFinishReason ? { finish_reason: finalFinishReason } : {}),
        },
        stored_parts: stored,
        ...(finalTokens ? { tokens: tokenSummary(finalTokens) } : {}),
        flags,
        created_at: input.createdAt,
        completed_at: final.completedAt,
        ...(stream ? { stream } : {}),
      }
    },
  }
}

function durationSince(start: number | undefined, end: number) {
  if (start === undefined) return undefined
  return Math.max(0, end - start)
}

export function storedPartCounts(parts: MessageV2.Part[]): StoredParts {
  const counts: StoredParts = {
    text: 0,
    reasoning: 0,
    tool: 0,
    step_start: 0,
    step_finish: 0,
    patch: 0,
    file: 0,
    other: 0,
  }
  for (const part of parts) countPart(counts, part.type)
  return counts
}

function countPart(counts: StoredParts, type: MessageV2.Part["type"]) {
  if (type === "step-start") counts.step_start++
  else if (type === "step-finish") counts.step_finish++
  else if (type === "text") counts.text++
  else if (type === "reasoning") counts.reasoning++
  else if (type === "tool") counts.tool++
  else if (type === "patch") counts.patch++
  else if (type === "file") counts.file++
  else counts.other++
}

function safeOptions(options: Record<string, unknown> | undefined): RequestSummary["options"] | undefined {
  if (!options) return undefined
  const result: NonNullable<RequestSummary["options"]> = {}
  const temperature = number(options.temperature)
  const topP = number(options.topP)
  const topK = number(options.topK)
  const maxOutputTokens = number(options.maxOutputTokens)
  if (temperature !== undefined) result.temperature = temperature
  if (topP !== undefined) result.top_p = topP
  if (topK !== undefined) result.top_k = topK
  if (maxOutputTokens !== undefined) result.max_output_tokens = maxOutputTokens
  return Object.keys(result).length ? result : undefined
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function emptyStreamEvents(): StreamEvents {
  return {
    start: 0,
    start_step: 0,
    finish_step: 0,
    finish: 0,
    text_start: 0,
    text_delta: 0,
    text_end: 0,
    reasoning_start: 0,
    reasoning_delta: 0,
    reasoning_end: 0,
    tool_input_start: 0,
    tool_input_delta: 0,
    tool_input_end: 0,
    tool_call: 0,
    tool_result: 0,
    tool_error: 0,
    error: 0,
  }
}

function countEvent(events: StreamEvents, type: string) {
  const key = type.replaceAll("-", "_") as keyof StreamEvents
  if (key in events && typeof events[key] === "number") events[key]++
}

function tokenSummary(tokens: MessageV2.Assistant["tokens"]): Tokens {
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cache_read: tokens.cache.read,
    cache_write: tokens.cache.write,
  }
}

function isEmptyCompletion(finishReason: string | undefined, stored: StoredParts) {
  return (
    finishReason === "stop" && stored.text === 0 && stored.reasoning === 0 && stored.tool === 0 && stored.file === 0
  )
}
