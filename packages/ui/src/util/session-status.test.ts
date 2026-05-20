import { describe, expect, test } from "bun:test"
import { isWorkInFlightStatus } from "./session-status"

describe("isWorkInFlightStatus", () => {
  test("undefined → false", () => {
    expect(isWorkInFlightStatus(undefined)).toBe(false)
  })
  test("idle → false", () => {
    expect(isWorkInFlightStatus({ type: "idle" })).toBe(false)
  })
  test("busy → true", () => {
    expect(isWorkInFlightStatus({ type: "busy" })).toBe(true)
  })
  test("retry → true", () => {
    expect(
      isWorkInFlightStatus({
        type: "retry",
        attempt: 1,
        message: "x",
        next: 0,
      }),
    ).toBe(true)
  })
  test("rate_limit_blocked → false (terminal-visible, not running)", () => {
    expect(
      isWorkInFlightStatus({
        type: "rate_limit_blocked",
        classification: {
          kind: "free_quota_exhausted",
          providerID: "opencode" as never, // branded ProviderID — narrow type is enforced server-side
          raw: "x",
        },
      }),
    ).toBe(false)
  })
})
