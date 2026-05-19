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
