import { describe, expect, test } from "bun:test"
import { ProviderID } from "@/provider/schema"
import { SessionStatus } from "./status"

describe("SessionStatus.Info schema", () => {
  test("parses idle", () => {
    expect(SessionStatus.Info.parse({ type: "idle" })).toEqual({ type: "idle" })
  })

  test("parses busy", () => {
    expect(SessionStatus.Info.parse({ type: "busy" })).toEqual({ type: "busy" })
  })

  test("parses retry with required fields, no classification", () => {
    const input = { type: "retry" as const, attempt: 1, message: "x", next: 0 }
    const result = SessionStatus.Info.parse(input)
    expect(result.type).toBe("retry")
    if (result.type === "retry") {
      expect(result.classification).toBeUndefined()
    }
  })

  test("parses retry with optional classification", () => {
    const result = SessionStatus.Info.parse({
      type: "retry",
      attempt: 2,
      message: "Provider is overloaded",
      next: 1_000,
      classification: {
        kind: "unknown",
        raw: "Provider is overloaded",
      },
    })
    expect(result.type).toBe("retry")
    if (result.type === "retry") {
      expect(result.classification?.kind).toBe("unknown")
    }
  })

  test("parses safe recovery retry with stable reason", () => {
    const result = SessionStatus.Info.parse({
      type: "retry",
      attempt: 1,
      message: "",
      next: 1_000,
      presentation: "safe_recovery",
      reason: "network_connection_dropped",
    })
    expect(result.type).toBe("retry")
    if (result.type === "retry") {
      expect(result.message).toBe("")
      expect(result.presentation).toBe("safe_recovery")
      expect(result.reason).toBe("network_connection_dropped")
    }
  })

  test("parses rate_limit_blocked with required classification", () => {
    const result = SessionStatus.Info.parse({
      type: "rate_limit_blocked",
      classification: {
        kind: "free_quota_exhausted",
        providerID: ProviderID.opencode,
        raw: "Free usage exceeded",
      },
    })
    expect(result.type).toBe("rate_limit_blocked")
    if (result.type === "rate_limit_blocked") {
      expect(result.classification.kind).toBe("free_quota_exhausted")
    }
  })

  test("rejects rate_limit_blocked without classification", () => {
    expect(() => SessionStatus.Info.parse({ type: "rate_limit_blocked" })).toThrow()
  })

  test("rejects unknown type literal", () => {
    expect(() => SessionStatus.Info.parse({ type: "banana" })).toThrow()
  })
})
