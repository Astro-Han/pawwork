import type { MessageV2 } from "../message-v2"
import { MessageID, SessionID } from "../schema"
import z from "zod"

export const SCHEMA_VERSION = 1

export const RequestSummary = z.object({
  streaming: z.literal(true),
  tool_count: z.number().int().nonnegative(),
  tool_choice: z.enum(["auto", "required", "none"]).optional(),
  small: z.boolean(),
  reasoning_capability: z.boolean(),
  interleaved_field: z.string().optional(),
  options: z
    .object({
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      top_k: z.number().optional(),
      max_output_tokens: z.number().optional(),
    })
    .optional(),
})
export type RequestSummary = z.infer<typeof RequestSummary>

export const StreamEvents = z.object({
  start: z.number().int().nonnegative(),
  start_step: z.number().int().nonnegative(),
  finish_step: z.number().int().nonnegative(),
  finish: z.number().int().nonnegative(),
  text_start: z.number().int().nonnegative(),
  text_delta: z.number().int().nonnegative(),
  text_end: z.number().int().nonnegative(),
  reasoning_start: z.number().int().nonnegative(),
  reasoning_delta: z.number().int().nonnegative(),
  reasoning_end: z.number().int().nonnegative(),
  tool_input_start: z.number().int().nonnegative(),
  tool_input_delta: z.number().int().nonnegative(),
  tool_input_end: z.number().int().nonnegative(),
  tool_call: z.number().int().nonnegative(),
  tool_result: z.number().int().nonnegative(),
  tool_error: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
  finish_reason: z.string().optional(),
})
export type StreamEvents = z.infer<typeof StreamEvents>

export const StoredParts = z.object({
  text: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
  tool: z.number().int().nonnegative(),
  step_start: z.number().int().nonnegative(),
  step_finish: z.number().int().nonnegative(),
  patch: z.number().int().nonnegative(),
  file: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
})
export type StoredParts = z.infer<typeof StoredParts>

export const Tokens = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
  cache_read: z.number().int().nonnegative(),
  cache_write: z.number().int().nonnegative(),
})
export type Tokens = z.infer<typeof Tokens>

export const Flags = z.object({
  empty_completion: z.boolean(),
  stream_error: z.boolean().optional(),
  aborted: z.boolean().optional(),
})
export type Flags = z.infer<typeof Flags>

export const Summary = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  trace_id: MessageID.zod,
  session_id: SessionID.zod,
  message_id: MessageID.zod,
  parent_message_id: MessageID.zod.optional(),
  provider: z.string(),
  model: z.string(),
  agent: z.string(),
  variant: z.string().optional(),
  request: RequestSummary.optional(),
  stream_events: StreamEvents,
  stored_parts: StoredParts,
  tokens: Tokens.optional(),
  flags: Flags,
  created_at: z.number(),
  completed_at: z.number().optional(),
})
export type Summary = z.infer<typeof Summary>

export type RequestSummaryInput = {
  streaming: true
  toolCount: number
  toolChoice?: "auto" | "required" | "none"
  small: boolean
  reasoningCapability: boolean
  interleavedField?: string
  options?: Record<string, unknown>
}

export type RecorderInput = {
  traceID: MessageID
  sessionID: SessionID
  messageID: MessageID
  parentMessageID?: MessageID
  providerID: string
  modelID: string
  agent: string
  variant?: string
  createdAt: number
}

export type FinalizeInput = {
  completedAt?: number
  finishReason?: string
  request?: RequestSummary
  storedParts: MessageV2.Part[]
  tokens?: MessageV2.Assistant["tokens"]
  streamError?: boolean
  aborted?: boolean
}

export type Recorder = {
  request(summary: RequestSummary): void
  observeEvent(event: { type: string } & Record<string, unknown>): void
  finish(reason: string | undefined, tokens?: MessageV2.Assistant["tokens"]): void
  finalize(input: FinalizeInput): Summary
}
