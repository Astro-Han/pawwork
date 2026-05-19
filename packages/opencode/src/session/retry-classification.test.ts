import { describe, expect, test } from "bun:test"
import { ProviderID } from "@/provider/schema"
import { RetryClassification, retryAction } from "./retry-classification"

describe("RetryClassification schema", () => {
  test("parses free_quota_exhausted classification with all optional fields", () => {
    const input = {
      kind: "free_quota_exhausted" as const,
      providerID: ProviderID.opencode,
      raw: "Free usage exceeded",
      statusCode: 429,
      retryAfterMs: 70_000,
      resetAt: 1_716_120_000_000,
    }
    const parsed = RetryClassification.parse(input)
    expect(parsed).toEqual(input)
  })

  test("parses free_quota_exhausted with only required fields", () => {
    const input = {
      kind: "free_quota_exhausted" as const,
      providerID: ProviderID.opencode,
      raw: "x",
    }
    expect(RetryClassification.parse(input)).toEqual(input)
  })

  test("parses unknown legacy classification", () => {
    const input = {
      kind: "unknown" as const,
      raw: "Provider is overloaded",
      statusCode: 503,
    }
    expect(RetryClassification.parse(input)).toEqual(input)
  })

  test("rejects unknown kind value", () => {
    expect(() => RetryClassification.parse({ kind: "banana", raw: "x" })).toThrow()
  })
})

describe("retryAction", () => {
  test("free_quota_exhausted maps to stop", () => {
    expect(
      retryAction({
        kind: "free_quota_exhausted",
        providerID: ProviderID.opencode,
        raw: "x",
      }),
    ).toBe("stop")
  })

  test("legacy retryable classification maps to retry", () => {
    expect(retryAction({ kind: "unknown", raw: "x" })).toBe("retry")
  })
})
