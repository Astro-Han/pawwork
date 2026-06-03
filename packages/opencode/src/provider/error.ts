import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import z from "zod"
import { iife } from "@/util/iife"
import type { ProviderID } from "./schema"

// Canonical, serializable classification of a provider/API failure. Populated
// once where the payload is parsed and carried on APIError.data.providerFailure
// so retry/UI/observability read one field instead of re-sniffing strings.
// (free_quota_exhausted stays a retry-time concept — it depends on retry-after
// headers and wall-clock resetAt — and is intentionally not a providerFailure
// kind; context overflow keeps its own ContextOverflowError name.)
export const ProviderFailureKind = z.enum([
  "auth",
  "rate_limit",
  "quota_exhausted",
  "server_overload",
  "invalid_request",
  "transport_disconnect",
  "decompression",
  "unknown",
])
export type ProviderFailureKind = z.infer<typeof ProviderFailureKind>

function apiCallErrorKind(statusCode: number | undefined, code: string | undefined): ProviderFailureKind {
  if (code === "insufficient_quota" || code === "usage_not_included") return "quota_exhausted"
  if (code === "invalid_prompt") return "invalid_request"
  if (code === "server_error" || code === "server_is_overloaded") return "server_overload"
  if (statusCode === 401 || statusCode === 403) return "auth"
  if (statusCode === 429) return "rate_limit"
  if (statusCode !== undefined && statusCode >= 500) return "server_overload"
  return "unknown"
}

// Adapted from overflow detection patterns in:
// https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/utils/overflow.ts
const OVERFLOW_PATTERNS = [
  /prompt is too long/i, // Anthropic
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions + Responses API message text)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter, DeepSeek, vLLM
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding, Moonshot
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /request entity too large/i, // HTTP 413
  /context length is only \d+ tokens/i, // vLLM
  /input length.*exceeds.*context length/i, // vLLM
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /too large for model with \d+ maximum context length/i, // Mistral
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
]

function isOpenAiErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  // openai sometimes returns 404 for models that are actually available
  return status === 404 || e.isRetryable
}

// Providers not reliably handled in this function:
// - z.ai: can accept overflow silently (needs token-count/context-window checks)
function isOverflow(message: string) {
  if (OVERFLOW_PATTERNS.some((p) => p.test(message))) return true

  // Providers/status patterns handled outside of regex list:
  // - Cerebras: often returns "400 (no body)" / "413 (no body)"
  // - Mistral: often returns "400 (no body)" / "413 (no body)"
  return /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)
}

function message(providerID: ProviderID, e: APICallError) {
  return iife(() => {
    const msg = e.message
    if (msg === "") {
      if (e.responseBody) return e.responseBody
      if (e.statusCode) {
        const err = STATUS_CODES[e.statusCode]
        if (err) return err
      }
      return "Unknown error"
    }

    if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
      return msg
    }

    try {
      const body = JSON.parse(e.responseBody)
      // try to extract common error message fields
      const errMsg = body.message || body.error || body.error?.message
      if (errMsg && typeof errMsg === "string") {
        return `${msg}: ${errMsg}`
      }
    } catch {}

    // If responseBody is HTML (e.g. from a gateway or proxy error page),
    // provide a human-readable message instead of dumping raw markup
    if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
      if (e.statusCode === 401) {
        return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `opencode auth login <your provider URL>` to re-authenticate."
      }
      if (e.statusCode === 403) {
        return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
      }
      return msg
    }

    return `${msg}: ${e.responseBody}`
  }).trim()
}

function json(input: unknown) {
  if (typeof input === "string") {
    try {
      const result = JSON.parse(input)
      if (result && typeof result === "object") return result
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof input === "object" && input !== null) {
    return input
  }
  return undefined
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

export type ParsedStreamError =
  | {
      type: "context_overflow"
      message: string
      responseBody: string
    }
  | {
      type: "api_error"
      message: string
      isRetryable: boolean
      responseBody: string
      kind?: ProviderFailureKind
      code?: string
    }

export function parseStreamError(input: unknown): ParsedStreamError | undefined {
  const raw = json(input)
  if (!isRecord(raw)) return

  const inner = typeof raw.message === "string" ? json(raw.message) : undefined
  // OpenAI stream errors can arrive wrapped in an Error-like object. Use the
  // inner provider payload so responseBody matches the payload users need.
  const body = isRecord(inner) && inner.type === "error" ? inner : raw

  const responseBody = JSON.stringify(body)
  if (body.type !== "error") return

  const error = isRecord(body.error) ? body.error : undefined
  const code = typeof error?.code === "string" ? error.code : undefined
  switch (error?.code) {
    case "context_length_exceeded":
      return {
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody,
      }
    case "insufficient_quota":
      return {
        type: "api_error",
        message: "Quota exceeded. Check your plan and billing details.",
        isRetryable: false,
        responseBody,
        kind: "quota_exhausted",
        code,
      }
    case "usage_not_included":
      return {
        type: "api_error",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        isRetryable: false,
        responseBody,
        kind: "quota_exhausted",
        code,
      }
    case "invalid_prompt":
      return {
        type: "api_error",
        message: typeof error.message === "string" ? error.message : "Invalid prompt.",
        isRetryable: false,
        responseBody,
        kind: "invalid_request",
        code,
      }
    case "server_is_overloaded":
    case "server_error":
      return {
        type: "api_error",
        message: typeof error.message === "string" ? error.message : "Server error.",
        isRetryable: true,
        responseBody,
        kind: "server_overload",
        code,
      }
  }
}

export type ParsedAPICallError =
  | {
      type: "context_overflow"
      message: string
      responseBody?: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
      kind?: ProviderFailureKind
      code?: string
    }

export function parseAPICallError(input: { providerID: ProviderID; error: APICallError }): ParsedAPICallError {
  const m = message(input.providerID, input.error)
  const body = json(input.error.responseBody)
  if (isOverflow(m) || input.error.statusCode === 413 || body?.error?.code === "context_length_exceeded") {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  const metadata = input.error.url ? { url: input.error.url } : undefined
  const code = typeof body?.error?.code === "string" ? body.error.code : undefined
  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: input.providerID.startsWith("openai") ? isOpenAiErrorRetryable(input.error) : input.error.isRetryable,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
    kind: apiCallErrorKind(input.error.statusCode, code),
    code,
  }
}

const ProviderErrorParseStreamErrorValue = parseStreamError
const ProviderErrorParseAPICallErrorValue = parseAPICallError

export namespace ProviderError {
  export type ParsedStreamError = import("./error").ParsedStreamError
  export type ParsedAPICallError = import("./error").ParsedAPICallError

  export const parseStreamError = ProviderErrorParseStreamErrorValue
  export const parseAPICallError = ProviderErrorParseAPICallErrorValue
}
