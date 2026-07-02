import { describe, expect, test } from "bun:test"
import { MessageV2 } from "./message-v2"
import { ProviderID } from "@/provider/schema"
import { classifyRetry, retryAction } from "./retry"

describe("APIError schema", () => {
  test("parses historical JSON without providerID", () => {
    const result = MessageV2.APIError.Schema.parse({
      name: "APIError",
      data: {
        message: "boom",
        isRetryable: false,
        statusCode: 500,
      },
    })
    expect(result.data.providerID).toBeUndefined()
  })

  test("preserves providerID when present", () => {
    const result = MessageV2.APIError.Schema.parse({
      name: "APIError",
      data: {
        message: "boom",
        isRetryable: false,
        providerID: ProviderID.opencode,
      },
    })
    expect(result.data.providerID).toBe("opencode")
  })
})

const makeAPIError = (data: Partial<MessageV2.APIError["data"]>): MessageV2.APIError =>
  ({
    name: "APIError" as const,
    data: {
      message: "boom",
      isRetryable: true,
      ...data,
    },
  }) as MessageV2.APIError

describe("classifyRetry — free_quota_exhausted positive", () => {
  test("opencode + FreeUsageLimitError in body classifies as free_quota_exhausted", () => {
    const error = makeAPIError({
      providerID: ProviderID.opencode,
      statusCode: 429,
      responseBody: '{"error":{"type":"FreeUsageLimitError"}}',
      responseHeaders: { "retry-after": "70" }, // 70 seconds
    })
    const classification = classifyRetry(error)
    expect(classification?.kind).toBe("free_quota_exhausted")
    if (classification?.kind === "free_quota_exhausted") {
      expect(classification.providerID).toBe(ProviderID.opencode)
      expect(classification.statusCode).toBe(429)
      expect(classification.retryAfterMs).toBe(70_000)
      expect(classification.resetAt).toBeDefined()
    }
  })

  test("typed FreeUsageLimitError stream body still routes to free_quota_exhausted", () => {
    // Real FreeUsageLimitError arrives as an APICallError 429, but the typed
    // stream shape must classify end-to-end too: fromError keeps it kind=unknown
    // and retryable, so classifyRetry can reach the free-quota branch.
    const error = MessageV2.fromError(
      { type: "error", error: { type: "FreeUsageLimitError", message: "FreeUsageLimitError" } },
      { providerID: ProviderID.opencode },
    )
    expect(classifyRetry(error)?.kind).toBe("free_quota_exhausted")
  })
})

describe("classifyRetry — reverse guards", () => {
  test("non-opencode provider + marker body falls to unknown", () => {
    const error = makeAPIError({
      providerID: "openai",
      responseBody: '{"error":{"type":"FreeUsageLimitError"}}',
      statusCode: 429,
    })
    expect(classifyRetry(error)?.kind).toBe("unknown")
  })

  test("opencode without marker body falls to unknown", () => {
    const error = makeAPIError({
      providerID: ProviderID.opencode,
      responseBody: "Rate limited",
      statusCode: 429,
    })
    expect(classifyRetry(error)?.kind).toBe("unknown")
  })

  test("APIError without providerID + marker body falls to unknown", () => {
    const error = makeAPIError({
      responseBody: '{"error":{"type":"FreeUsageLimitError"}}',
    })
    expect(classifyRetry(error)?.kind).toBe("unknown")
  })
})

describe("classifyRetry — legacy retryable classifications stay unknown", () => {
  test("APIError with Overloaded message → unknown with normalized raw", () => {
    const error = makeAPIError({ message: "Provider is Overloaded" })
    const c = classifyRetry(error)
    expect(c?.kind).toBe("unknown")
    if (c?.kind === "unknown") expect(c.raw).toContain("overloaded")
  })

  test("plain-text rate limit message → unknown with raw preserved", () => {
    const error = {
      name: "OtherError" as const,
      data: { message: "Rate limit exceeded" },
    } as unknown as Parameters<typeof classifyRetry>[0]
    const c = classifyRetry(error)
    expect(c?.kind).toBe("unknown")
  })

  test("context overflow returns undefined (not retryable)", () => {
    const overflow = {
      name: "ContextOverflowError" as const,
      data: { message: "context overflow", maxTokens: 0, currentTokens: 1 },
    } as unknown as Parameters<typeof classifyRetry>[0]
    expect(classifyRetry(overflow)).toBeUndefined()
  })

  test("APIError isRetryable=false + statusCode<500 → undefined", () => {
    const error = makeAPIError({ isRetryable: false, statusCode: 400 })
    expect(classifyRetry(error)).toBeUndefined()
  })
})

describe("classifyRetry — reads providerFailure.kind (slice ④)", () => {
  // Terminal kinds are client-side failures retrying cannot fix. Reading the
  // canonical kind means they never retry even if the provider SDK wrongly
  // marked the error retryable.
  for (const kind of ["auth", "invalid_request", "quota_exhausted"] as const) {
    test(`terminal kind ${kind} never retries (kind overrides a retryable SDK flag)`, () => {
      expect(classifyRetry(makeAPIError({ isRetryable: true, providerFailure: { kind } }))).toBeUndefined()
    })
  }

  // Transient kinds always retry, even if isRetryable is false and the status is
  // not 5xx — the classification, not the SDK flag, is the source of truth.
  for (const kind of ["rate_limit", "server_overload", "decompression"] as const) {
    test(`transient kind ${kind} retries even when isRetryable is false and status is not 5xx`, () => {
      expect(
        classifyRetry(makeAPIError({ isRetryable: false, statusCode: 400, providerFailure: { kind } }))?.kind,
      ).toBe("unknown")
    })
  }

  // transport_disconnect honors the per-errno isRetryable the stream classifier
  // sets (#1105b): most transport errnos are transient, but a permanent one
  // (e.g. ENOTFOUND — unresolved host) is marked isRetryable=false and must not
  // auto-retry into a stall.
  test("transport_disconnect retries when the classifier marked it retryable", () => {
    expect(
      classifyRetry(makeAPIError({ isRetryable: true, providerFailure: { kind: "transport_disconnect" } }))?.kind,
    ).toBe("unknown")
  })

  test("transport_disconnect does not retry when the classifier marked it non-retryable", () => {
    expect(
      classifyRetry(makeAPIError({ isRetryable: false, providerFailure: { kind: "transport_disconnect" } })),
    ).toBeUndefined()
  })

  test("unknown kind falls back to the legacy isRetryable + 5xx gate", () => {
    expect(
      classifyRetry(makeAPIError({ isRetryable: true, statusCode: 404, providerFailure: { kind: "unknown" } }))?.kind,
    ).toBe("unknown")
    expect(
      classifyRetry(makeAPIError({ isRetryable: false, statusCode: 404, providerFailure: { kind: "unknown" } })),
    ).toBeUndefined()
    expect(
      classifyRetry(makeAPIError({ isRetryable: false, statusCode: 503, providerFailure: { kind: "unknown" } }))?.kind,
    ).toBe("unknown")
  })

  test("absent providerFailure keeps legacy behavior (back-compat with historical rows)", () => {
    expect(classifyRetry(makeAPIError({ isRetryable: false, statusCode: 400 }))).toBeUndefined()
    expect(classifyRetry(makeAPIError({ isRetryable: true, statusCode: 429 }))?.kind).toBe("unknown")
    expect(classifyRetry(makeAPIError({ isRetryable: false, statusCode: 503 }))?.kind).toBe("unknown")
  })

  test("free_quota_exhausted still wins for opencode + marker, regardless of kind", () => {
    const error = makeAPIError({
      providerID: ProviderID.opencode,
      statusCode: 429,
      responseBody: '{"error":{"type":"FreeUsageLimitError"}}',
      responseHeaders: { "retry-after": "70" },
      providerFailure: { kind: "rate_limit" },
    })
    expect(classifyRetry(error)?.kind).toBe("free_quota_exhausted")
  })

  test("retry-notice copy is unchanged when reading kind (option A keeps provider message)", () => {
    const descriptive = makeAPIError({
      isRetryable: true,
      statusCode: 503,
      message: "The server is overloaded. Please try again later. (request id req_abc)",
      providerFailure: { kind: "server_overload" },
    })
    const c = classifyRetry(descriptive)
    expect(c?.kind).toBe("unknown")
    if (c?.kind === "unknown") {
      expect(c.raw).toBe("The server is overloaded. Please try again later. (request id req_abc)")
    }

    const normalized = makeAPIError({ message: "Provider is Overloaded", providerFailure: { kind: "server_overload" } })
    const c2 = classifyRetry(normalized)
    if (c2?.kind === "unknown") expect(c2.raw).toBe("Provider is overloaded")
  })
})

describe("retryAction re-exported from retry.ts", () => {
  test("free_quota_exhausted maps to stop", () => {
    expect(
      retryAction({
        kind: "free_quota_exhausted",
        providerID: ProviderID.opencode,
        raw: "x",
      }),
    ).toBe("stop")
  })
  test("unknown maps to retry", () => {
    expect(retryAction({ kind: "unknown", raw: "x" })).toBe("retry")
  })
})
