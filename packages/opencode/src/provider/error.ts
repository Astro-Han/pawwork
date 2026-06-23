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
  // 402 Payment Required = account can no longer pay for the call. Same user
  // action as a depleted quota (top up or switch model), so it reuses
  // quota_exhausted rather than adding a near-duplicate payment_required kind.
  if (statusCode === 402) return "quota_exhausted"
  // 400/422 are client-side request rejections. Overflow 4xx is already routed
  // to context_overflow before this runs, so what reaches here is a genuine
  // invalid request rather than an over-long prompt.
  if (statusCode === 400 || statusCode === 422) return "invalid_request"
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

// Billing/quota failures providers report under inconsistent status codes and
// codes (e.g. DeepSeek returns 402 *or* 400 with "Insufficient Balance"). The
// strong patterns are unambiguous and match regardless of status; the weak
// patterns ("quota exceeded") overlap with transient rate limits, so they only
// apply on a billing-shaped status with no rate-limit signal.
const STRONG_BILLING_PATTERNS = [
  /insufficient balance/i, // DeepSeek
  /out of credits?/i, // OpenRouter and others
  /payment required/i,
  /in arrears/i,
  /余额不足/, // zh: insufficient balance
  /欠费/, // zh: in arrears
]
const WEAK_BILLING_PATTERNS = [
  /quota.{0,16}(exceed|exhaust)/i,
  /(exceed|exhaust).{0,16}quota/i,
  /billing (issue|problem|error)/i,
  /add (credits?|funds?|balance)/i,
  /out of funds?/i,
]
// 429 is deliberately excluded: it is Too Many Requests, so even "quota
// exceeded" wording (e.g. Google's per-minute request quota) is a retryable
// rate limit, not a terminal billing failure. Genuine depleted-balance/hard
// quota arrives as 402/403 or a known code (insufficient_quota) handled above.
const WEAK_BILLING_STATUS = new Set([400, 402, 403])

// opencode's free-tier limit reuses a 429 with a billing-ish marker, but it must
// stay a retry-time free_quota_exhausted concept (countdown card), never the
// terminal quota_exhausted kind. Excluded from billing classification here.
function isFreeUsageLimit(text: string) {
  return /FreeUsageLimitError/.test(text)
}

function hasRateLimitSignal(text: string, headers?: Record<string, string>) {
  if (headers && (headers["retry-after"] || headers["retry-after-ms"])) return true
  return /rate[ _-]?limit/i.test(text) || /too many requests/i.test(text)
}

function billingKindFor(opts: {
  text: string
  statusCode?: number
  headers?: Record<string, string>
}): ProviderFailureKind | undefined {
  if (isFreeUsageLimit(opts.text)) return undefined
  if (STRONG_BILLING_PATTERNS.some((p) => p.test(opts.text))) return "quota_exhausted"
  const statusOk = opts.statusCode !== undefined && WEAK_BILLING_STATUS.has(opts.statusCode)
  if (statusOk && !hasRateLimitSignal(opts.text, opts.headers) && WEAK_BILLING_PATTERNS.some((p) => p.test(opts.text))) {
    return "quota_exhausted"
  }
  return undefined
}

// Transient signals in the provider *code* that the retry classifier treats as
// retryable. Scans the code only, never the free-text message, so a terminal
// error whose message merely mentions "unavailable"/"exhausted" is not wrongly
// retried. The "exhausted" match is scoped to resource_exhausted (Google's
// transient overload) — a terminal quota_exhausted/insufficient_quota code must
// NOT be treated as transient.
const TRANSIENT_CODE_PATTERN = /resource[ _-]?exhausted|unavailable|overloaded|rate[ _-]?limit|too[ _-]?many[ _-]?requests/i
function looksTransientCode(code: string | undefined) {
  return code !== undefined && TRANSIENT_CODE_PATTERN.test(code)
}

// Single place that pulls a provider error code out of a parsed body, covering
// the shapes providers actually use: OpenAI-style error.code, top-level code,
// error.type, and Google-style status (error.status / status).
function extractProviderCode(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const error = isRecord(body.error) ? body.error : undefined
  if (error && typeof error.code === "string") return error.code
  if (typeof body.code === "string") return body.code
  if (error && typeof error.type === "string") return error.type
  if (error && typeof error.status === "string") return error.status
  if (typeof body.status === "string") return body.status
  return undefined
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

    // Surface the provider's nested reason from a structured body first — even
    // when the SDK message is a custom string rather than the bare HTTP reason
    // phrase. Otherwise a message like "API call failed" would early-return and
    // suppress the real {error:{message}} reason (e.g. DeepSeek's "Insufficient
    // Balance"). Many providers wrap it as {error:{message}} where body.error is
    // an object, so checking body.error before body.error.message would
    // short-circuit on the object and dump the raw body instead of the string.
    if (e.responseBody) {
      try {
        const body = JSON.parse(e.responseBody)
        const nested = typeof body?.error?.message === "string" ? body.error.message : undefined
        const top = typeof body?.message === "string" ? body.message : undefined
        const errString = typeof body?.error === "string" ? body.error : undefined
        const errMsg = nested ?? top ?? errString
        if (errMsg) {
          // Avoid "msg: msg" duplication when the SDK message already carries it.
          return msg.includes(errMsg) ? msg : `${msg}: ${errMsg}`
        }
      } catch {}
    }

    // No structured reason to surface. A non-reason-phrase SDK message stands on
    // its own; a bare reason phrase with a body falls through to HTML/raw below.
    if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
      return msg
    }

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

function isBareProviderError(input: unknown): input is Record<string, unknown> {
  return isRecord(input) && typeof input.code === "string"
}

function isStreamErrorBody(input: unknown): input is Record<string, unknown> {
  return isRecord(input) && (input.type === "error" || isBareProviderError(input))
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
  const cause = isRecord(raw.cause) ? raw.cause : undefined
  const causeBody = cause ? json(cause.body) : undefined
  // OpenAI stream errors can arrive wrapped in an Error-like object. Use the
  // inner provider payload so responseBody matches the payload users need.
  const body = isStreamErrorBody(inner) ? inner : isStreamErrorBody(causeBody) ? causeBody : raw

  const responseBody = JSON.stringify(body)
  const error = body.type === "error" && isRecord(body.error) ? body.error : isBareProviderError(body) ? body : undefined
  if (!error) return

  // Read code from the resolved error only (never dig into an untyped body —
  // that is the over-match guard `if (!error) return` above protects). Fall back
  // to error.type so providers that put the code under `type` still classify.
  const code =
    typeof error.code === "string" ? error.code : typeof error.type === "string" ? error.type : undefined
  switch (code) {
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
    case "authentication_error":
    case "invalid_api_key":
    case "permission_denied":
      return {
        type: "api_error",
        message: typeof error.message === "string" ? error.message : "Authentication failed.",
        isRetryable: false,
        responseBody,
        kind: "auth",
        code,
      }
    case "rate_limit_exceeded":
    case "too_many_requests":
    case "rate_limited":
      return {
        type: "api_error",
        message: typeof error.message === "string" ? error.message : "Rate limit exceeded.",
        isRetryable: true,
        responseBody,
        kind: "rate_limit",
        code,
      }
  }

  const providerMessage = typeof error.message === "string" ? error.message : undefined
  const text = `${providerMessage ?? ""}\n${responseBody}`
  // No statusCode on the stream path, so only the unconditional strong billing
  // patterns can match here (weak patterns are status-gated).
  const billingKind = billingKindFor({ text })
  if (billingKind) {
    return {
      type: "api_error",
      message: providerMessage ?? "Quota exceeded. Check your plan and billing details.",
      isRetryable: false,
      responseBody,
      kind: billingKind,
      code,
    }
  }

  // PR1c middle path: a typed provider error envelope ({type:"error"} + error
  // object) with an unhandled code becomes a structured APIError(kind="unknown")
  // so the frontend gets code/responseBody instead of an opaque UnknownError. A
  // bare {code} body is intentionally NOT upgraded: it is indistinguishable from
  // a Node runtime error (e.g. EACCES) and stays UnknownError as before, keeping
  // its classifyRetry text-heuristic retry verdict unchanged.
  if (body.type !== "error") return
  return {
    type: "api_error",
    message: providerMessage ?? responseBody,
    // Retry verdict from the code only (never free-text): FreeUsageLimitError is
    // marked retryable so classifyRetry can route it to free_quota_exhausted;
    // otherwise a transient-looking code (exhausted/unavailable/rate limit) stays
    // retryable, matching the prior UnknownError verdict.
    isRetryable: isFreeUsageLimit(text) ? true : looksTransientCode(code),
    responseBody,
    kind: "unknown",
    code,
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
  const code = extractProviderCode(body)
  if (isOverflow(m) || input.error.statusCode === 413 || code === "context_length_exceeded") {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  const metadata = input.error.url ? { url: input.error.url } : undefined
  // Billing failures arrive under inconsistent statuses (DeepSeek 402 or a
  // generic 400). The billing override runs ahead of the status/code fallback so
  // an "Insufficient Balance" body classifies as quota_exhausted instead of the
  // invalid_request the bare status would imply.
  const billingKind = billingKindFor({
    text: `${m}\n${input.error.responseBody ?? ""}`,
    statusCode: input.error.statusCode,
    headers: input.error.responseHeaders,
  })
  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: input.providerID.startsWith("openai") ? isOpenAiErrorRetryable(input.error) : input.error.isRetryable,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
    kind: billingKind ?? apiCallErrorKind(input.error.statusCode, code),
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
