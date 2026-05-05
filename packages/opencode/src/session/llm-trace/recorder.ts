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
      }
    },
  }
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
  return finishReason === "stop" && stored.text === 0 && stored.reasoning === 0 && stored.tool === 0 && stored.file === 0
}
