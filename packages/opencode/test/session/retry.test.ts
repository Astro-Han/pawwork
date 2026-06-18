import { describe, expect, spyOn, test } from "bun:test"
import type { NamedError } from "@opencode-ai/util/error"
import { APICallError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Clock, Effect, Exit, Pull, Schedule } from "effect"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderID } from "../../src/provider/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const providerID = ProviderID.make("test")

function apiError(headers?: Record<string, string>): MessageV2.APIError {
  return new MessageV2.APIError({
    message: "boom",
    isRetryable: true,
    responseHeaders: headers,
  }).toObject() as MessageV2.APIError
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { data: { message } } as ReturnType<NamedError["toObject"]>
}

// Helper: extract the raw message from a classifyRetry result (mirrors old retryable() string return)
function retryableRaw(error: ReturnType<NamedError["toObject"]>): string | undefined {
  return SessionRetry.classifyRetry(error)?.raw
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing, with jitter within 50-100% of the exponential value", () => {
    const error = apiError()
    const base = [2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000]
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    // jitter equal-split: each delay lands in [50%, 100%] of the exponential base, capped at 30s
    delays.forEach((d, i) => {
      expect(d).toBeGreaterThanOrEqual(Math.round(base[i] * 0.5))
      expect(d).toBeLessThanOrEqual(base[i])
    })
  })

  test("exponential backoff applies equal jitter at 50%, midpoint, and 100% of the base", () => {
    // The core fix for issue #1348: parallel subagents retrying 429s must not retry
    // in lockstep. delay() applies equal jitter (50-100% of exponential base) so
    // concurrent callers land on different moments. Deterministic via Math.random
    // stubbing — no probabilistic draws.
    const base = 4000 // attempt 2, RETRY_INITIAL_DELAY * 2^(2-1)
    const cases = [
      { rand: 0, expected: 2000 }, // 50% lower bound: base * (0.5 + 0*0.5)
      { rand: 0.5, expected: 3000 }, // midpoint: base * (0.5 + 0.5*0.5)
      { rand: 0.999, expected: 3998 }, // near 100%: base * (0.5 + 0.999*0.5), rounded
    ]
    for (const { rand, expected } of cases) {
      const spy = spyOn(Math, "random").mockReturnValue(rand)
      try {
        expect(SessionRetry.delay(2)).toBe(expected)
      } finally {
        spy.mockRestore()
      }
    }
    // sanity: base is what we think it is, so the boundaries above are meaningful
    expect(base).toBe(SessionRetry.RETRY_INITIAL_DELAY * Math.pow(SessionRetry.RETRY_BACKOFF_FACTOR, 2 - 1))
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints and falls back to jittered exponential", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(1000)
    expect(d).toBeLessThanOrEqual(2000)
  })

  test("ignores malformed date retry hints and falls back to jittered exponential", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(1000)
    expect(d).toBeLessThanOrEqual(2000)
  })

  test("ignores past date retry hints and falls back to jittered exponential", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(1000)
    expect(d).toBeLessThanOrEqual(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("caps oversized header delays to the runtime timer limit", () => {
    const error = apiError({ "retry-after-ms": "999999999999" })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })

  test("policy updates retry status and increments attempts", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("session-retry-test")
        const error = apiError({ "retry-after-ms": "0" })

        await Effect.runPromise(
          Effect.gen(function* () {
            const step = yield* Schedule.toStepWithMetadata(
              SessionRetry.policy({
                parse: (err) => err as MessageV2.APIError,
                set: (info) =>
                  Effect.promise(() =>
                    AppRuntime.runPromise(
                      SessionStatus.Service.use((svc) =>
                        svc.set(sessionID, {
                          type: "retry",
                          attempt: info.attempt,
                          message: info.message,
                          next: info.next,
                        }),
                      ),
                    ),
                  ),
                signalTerminal: () => {},
              }),
            )
            yield* step(error)
            yield* step(error)
          }),
        )

        expect(await AppRuntime.runPromise(SessionStatus.Service.use((svc) => svc.get(sessionID)))).toMatchObject({
          type: "retry",
          attempt: 2,
          message: "boom",
        })
      },
    })
  })

  test("safe recovery policy emits lightweight retry presentation with separate attempt metadata", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("session-safe-recovery-retry-test")

        await Effect.runPromise(
          Effect.gen(function* () {
            const step = yield* Schedule.toStepWithMetadata(
              SessionRetry.safeRecoveryPolicy({
                set: (info) =>
                  Effect.promise(() =>
                    AppRuntime.runPromise(
                      SessionStatus.Service.use((svc) =>
                        svc.set(sessionID, {
                          type: "retry",
                          attempt: info.attempt,
                          message: info.message,
                          next: info.next,
                          presentation: info.presentation,
                          reason: info.reason,
                        }),
                      ),
                    ),
                  ),
              }),
            )
            yield* step(undefined)
          }),
        )

        expect(await AppRuntime.runPromise(SessionStatus.Service.use((svc) => svc.get(sessionID)))).toMatchObject({
          type: "retry",
          attempt: 1,
          message: "",
          presentation: "recovery",
          reason: "network_connection_dropped",
        })
      },
    })
  })

  test("delay() produces exponential backoff within the jittered range", () => {
    // Equal jitter (50-100% of exponential base) — see issue #1348.
    const bases = [2000, 4000, 8000]
    const got = [SessionRetry.delay(1), SessionRetry.delay(2), SessionRetry.delay(3)]
    got.forEach((d, i) => {
      expect(d).toBeGreaterThanOrEqual(Math.round(bases[i] * 0.5))
      expect(d).toBeLessThanOrEqual(bases[i])
    })
  })

  test("safe recovery policy uses injected delay across the replay budget then stops", async () => {
    const statuses: Array<{
      attempt: number
      message: string
      next: number
      presentation: "recovery"
      reason: "network_connection_dropped"
    }> = []

    const requestedWaits: number[] = []
    const fastDelay = (attempt: number) => {
      const wait = attempt * 10
      requestedWaits.push(wait)
      return wait
    }

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const step = yield* Schedule.toStepWithMetadata(
          SessionRetry.safeRecoveryPolicy({
            set: (info) => Effect.sync(() => statuses.push(info)),
            delay: fastDelay,
          }),
        )
        for (let attempt = 0; attempt < SessionRetry.SAFE_RECOVERY_MAX_ATTEMPTS; attempt++) {
          yield* step(undefined)
        }
        return yield* Effect.exit(step(undefined))
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Pull.isDoneCause(exit.cause)).toBe(true)
    }
    expect(statuses).toHaveLength(SessionRetry.SAFE_RECOVERY_MAX_ATTEMPTS)
    expect(statuses.map((status) => status.attempt)).toEqual([1, 2, 3])
    expect(requestedWaits).toEqual([10, 20, 30])
    expect(
      statuses.every(
        (status) =>
          status.message === "" && status.presentation === "recovery" && status.reason === "network_connection_dropped",
      ),
    ).toBe(true)
  })

  test("policy stops retrying after the configured max attempts", async () => {
    const attempts: number[] = []
    let runs = 0
    const error = apiError({ "retry-after-ms": "0" })

    const exit = await Effect.runPromiseExit(
      Effect.try({
        try: () => {
          runs++
          throw error
        },
        catch: (err) => err as MessageV2.APIError,
      }).pipe(
        Effect.retry(
          SessionRetry.policy({
            parse: (err) => err as MessageV2.APIError,
            set: (info) => Effect.sync(() => attempts.push(info.attempt)),
            signalTerminal: () => {},
          }),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(runs).toBe(SessionRetry.RETRY_MAX_ATTEMPTS)
    expect(attempts).toEqual(Array.from({ length: SessionRetry.RETRY_MAX_ATTEMPTS - 1 }, (_, index) => index + 1))
  })
})

describe("session.retry.classifyRetry", () => {
  test("maps too_many_requests json messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(retryableRaw(error)).toBe("Too Many Requests")
  })

  test("maps overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(retryableRaw(error)).toBe("Provider is overloaded")
  })

  test("does not retry unknown json messages", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(retryableRaw(error)).toBeUndefined()
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = retryableRaw(error)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(retryableRaw(error)).toBeUndefined()
  })

  test("retries plain text rate limit errors from Alibaba", () => {
    const msg =
      "Upstream error from Alibaba: Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."
    const error = wrap(msg)
    expect(retryableRaw(error)).toBe(msg)
  })

  test("retries plain text rate limit errors", () => {
    const msg = "Rate limit exceeded, please try again later"
    const error = wrap(msg)
    expect(retryableRaw(error)).toBe(msg)
  })

  test("retries too many requests in plain text", () => {
    const msg = "Too many requests, please slow down"
    const error = wrap(msg)
    expect(retryableRaw(error)).toBe(msg)
  })

  test("does not retry context overflow errors", () => {
    const error = new MessageV2.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject() as ReturnType<NamedError["toObject"]>

    expect(retryableRaw(error)).toBeUndefined()
  })

  test("retries 500 errors even when isRetryable is false", () => {
    const error = new MessageV2.APIError({
      message: "Internal server error",
      isRetryable: false,
      statusCode: 500,
      responseBody: '{"type":"api_error","message":"Internal server error"}',
    }).toObject() as MessageV2.APIError

    expect(retryableRaw(error)).toBe("Internal server error")
  })

  test("retries 502 bad gateway errors", () => {
    const error = new MessageV2.APIError({
      message: "Bad gateway",
      isRetryable: false,
      statusCode: 502,
    }).toObject() as MessageV2.APIError

    expect(retryableRaw(error)).toBe("Bad gateway")
  })

  test("retries 503 service unavailable errors", () => {
    const error = new MessageV2.APIError({
      message: "Service unavailable",
      isRetryable: false,
      statusCode: 503,
    }).toObject() as MessageV2.APIError

    expect(retryableRaw(error)).toBe("Service unavailable")
  })

  test("does not retry 4xx errors when isRetryable is false", () => {
    const error = new MessageV2.APIError({
      message: "Bad request",
      isRetryable: false,
      statusCode: 400,
    }).toObject() as MessageV2.APIError

    expect(retryableRaw(error)).toBeUndefined()
  })

  test("retries ZlibError decompression failures", () => {
    const error = new MessageV2.APIError({
      message: "Response decompression failed",
      isRetryable: true,
      metadata: { code: "ZlibError" },
    }).toObject() as MessageV2.APIError

    const raw = retryableRaw(error)
    expect(raw).toBeDefined()
    expect(raw).toBe("Response decompression failed")
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(_req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID })

      expect(MessageV2.APIError.isInstance(result)).toBe(true)
      expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
      expect((result as MessageV2.APIError).data.message).toInclude("socket connection")
      expect((result as MessageV2.APIError).data.metadata?.code).toBe("ECONNRESET")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = new MessageV2.APIError({
      message: "Connection reset by server",
      isRetryable: true,
      metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
    }).toObject() as MessageV2.APIError

    const raw = retryableRaw(error)
    expect(raw).toBeDefined()
    expect(raw).toBe("Connection reset by server")
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: ProviderID.make("openai") }) as MessageV2.APIError
    expect(result.data.isRetryable).toBe(true)
  })

  test("converts OpenAI server_error stream chunks to retryable APIError", () => {
    const result = MessageV2.fromError(
      {
        message: JSON.stringify({
          type: "error",
          sequence_number: 2,
          error: {
            type: "server_error",
            code: "server_error",
            message: "An error occurred while processing your request.",
            param: null,
          },
        }),
      },
      { providerID: ProviderID.make("openai") },
    )

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
    expect(retryableRaw(result)).toBe("An error occurred while processing your request.")
  })

  test("converts OpenAI server_is_overloaded stream chunks to retryable APIError", () => {
    const result = MessageV2.fromError(
      {
        message: JSON.stringify({
          type: "error",
          error: {
            code: "server_is_overloaded",
            message: "The server is overloaded. Please try again later.",
          },
        }),
      },
      { providerID: ProviderID.make("openai") },
    )

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
    expect(retryableRaw(result)).toBe("The server is overloaded. Please try again later.")
  })

  test("uses fallback message for OpenAI server_error stream chunks without message", () => {
    const result = MessageV2.fromError(
      {
        message: JSON.stringify({
          type: "error",
          error: {
            code: "server_error",
          },
        }),
      },
      { providerID: ProviderID.make("openai") },
    )

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
    expect((result as MessageV2.APIError).data.message).toBe("Server error.")
    expect(retryableRaw(result)).toBe("Server error.")
  })

  test("does not convert unknown OpenAI stream error chunks to retryable APIError", () => {
    const result = MessageV2.fromError(
      {
        message: JSON.stringify({
          type: "error",
          error: {
            code: "bad_request",
            message: "Bad request",
          },
        }),
      },
      { providerID: ProviderID.make("openai") },
    )

    expect(MessageV2.APIError.isInstance(result)).toBe(false)
    expect(retryableRaw(result)).toBeUndefined()
  })
})
