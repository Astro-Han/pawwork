import type { NamedError } from "@opencode-ai/util/error"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"
import { ProviderID } from "@/provider/schema"
import { type RetryClassification, retryAction } from "./retry-classification"

export type Err = ReturnType<NamedError["toObject"]>

export { retryAction } from "./retry-classification"
export type { RetryAction } from "./retry-classification"

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
export const RETRY_MAX_ATTEMPTS = 10
export const SAFE_RECOVERY_REPLAY_DELAY = 1_000
export const SAFE_RECOVERY_MAX_ATTEMPTS = 1

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: MessageV2.APIError) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
    }
  }

  return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
}

export function classifyRetry(error: Err): RetryClassification | undefined {
  // context overflow errors should not be retried
  if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
  if (MessageV2.APIError.isInstance(error)) {
    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (!error.data.isRetryable && !(status !== undefined && status >= 500)) return undefined

    // Strict 3-way AND: opencode provider + FreeUsageLimitError marker in body
    if (
      error.data.providerID === ProviderID.opencode &&
      error.data.responseBody?.includes("FreeUsageLimitError")
    ) {
      const headers = error.data.responseHeaders
      const retryAfterRaw = headers?.["retry-after"]
      let retryAfterMs: number | undefined
      let resetAt: number | undefined
      if (retryAfterRaw) {
        const secs = Number.parseFloat(retryAfterRaw)
        if (!Number.isNaN(secs)) {
          retryAfterMs = Math.ceil(secs * 1000)
          resetAt = Date.now() + retryAfterMs
        } else {
          const parsedDate = Date.parse(retryAfterRaw)
          if (!Number.isNaN(parsedDate)) {
            resetAt = parsedDate
            retryAfterMs = Math.max(0, parsedDate - Date.now())
          }
        }
      }
      return {
        kind: "free_quota_exhausted",
        // We already checked === ProviderID.opencode above; cast to satisfy Brand type
        providerID: ProviderID.opencode,
        raw: error.data.message,
        statusCode: error.data.statusCode,
        retryAfterMs,
        resetAt,
      }
    }

    // All other APIError retryable paths fall to unknown
    return {
      kind: "unknown",
      raw: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message,
      statusCode: error.data.statusCode,
    }
  }

  // Check for rate limit patterns in plain text error messages
  const msg = error.data?.message
  if (typeof msg === "string") {
    const lower = msg.toLowerCase()
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests")
    ) {
      return { kind: "unknown", raw: msg }
    }
  }

  const json = iife(() => {
    try {
      if (typeof error.data?.message === "string") {
        const parsed = JSON.parse(error.data.message)
        return parsed
      }

      return JSON.parse(error.data.message)
    } catch {
      return undefined
    }
  })
  if (!json || typeof json !== "object") return undefined
  const code = typeof json.code === "string" ? json.code : ""

  if (json.type === "error" && json.error?.type === "too_many_requests") {
    return { kind: "unknown", raw: "Too Many Requests" }
  }
  if (code.includes("exhausted") || code.includes("unavailable")) {
    return { kind: "unknown", raw: "Provider is overloaded" }
  }
  if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
    return { kind: "unknown", raw: "Rate Limited" }
  }
  return undefined
}

export function policy(opts: {
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; next: number }) => Effect.Effect<void>
  /**
   * Required. Called once when policy reaches a terminal classification
   * (currently: free_quota_exhausted) so the caller can persist it to ctx for
   * halt() to read. Sync callback — Schedule.fromStepWithMetadata's step return
   * union does not include Effect<Cause>, so terminal signaling has to be a side
   * effect we can invoke synchronously before returning Cause.done.
   */
  signalTerminal: (classification: RetryClassification) => void
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const classification = classifyRetry(error)
      if (!classification) return Cause.done(meta.attempt)
      if (retryAction(classification) === "stop") {
        opts.signalTerminal(classification)
        return Cause.done(meta.attempt)
      }
      if (meta.attempt >= RETRY_MAX_ATTEMPTS) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const wait = delay(meta.attempt, MessageV2.APIError.isInstance(error) ? error : undefined)
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({ attempt: meta.attempt, message: classification.raw, next: now + wait })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export function safeRecoveryPolicy(opts: {
  set: (input: {
    attempt: number
    message: string
    next: number
    presentation: "safe_recovery"
    reason: "network_connection_dropped"
  }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      if (meta.attempt > SAFE_RECOVERY_MAX_ATTEMPTS) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: "",
          next: now + SAFE_RECOVERY_REPLAY_DELAY,
          presentation: "safe_recovery",
          reason: "network_connection_dropped",
        })
        return [meta.attempt, Duration.millis(SAFE_RECOVERY_REPLAY_DELAY)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
