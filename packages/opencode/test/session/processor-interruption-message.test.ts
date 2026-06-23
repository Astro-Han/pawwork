import { describe, expect, test } from "bun:test"
import { haltInterruptionMessage } from "../../src/session/processor"
import type { RunObservability } from "../../src/session/run-observability"

type Recovery = NonNullable<RunObservability.Summary["incident"]>["recovery"]

// haltInterruptionMessage only reads recovery.reason; a minimal stub is enough.
function recovery(reason: NonNullable<Recovery>["reason"]): Recovery {
  return { reason } as unknown as Recovery
}

// The shared safety wording recoveryInterruptionMessage gives the side-effect
// reasons — the hint that must not be swallowed.
const SAFETY_HINT = "check whether the last operation completed"

describe("haltInterruptionMessage", () => {
  test("a terminal provider API rejection keeps its own message (no override)", () => {
    // reason "provider_api_error" only ever marks a terminal rejection (e.g. a
    // 402 "Insufficient Balance"); its real text must show, so return undefined
    // and let halt() leave the provider message in place.
    expect(haltInterruptionMessage(true, recovery("provider_api_error"))).toBeUndefined()
  })

  // The P1 fix: a retryable provider error (rate_limit / server_overload) that
  // exhausts its retries *after a side effect* is NOT terminal — the policy gives
  // it a safety reason, and that hint must survive even though rate_limit is a
  // provider-API kind. Suppressing it would risk the user re-running a
  // side-effecting operation.
  for (const reason of [
    "tool_execution_started",
    "unsafe_side_effect_started",
    "side_effect_facts_incomplete",
  ] as const) {
    test(`a retryable provider rejection with reason "${reason}" keeps the safety hint`, () => {
      expect(haltInterruptionMessage(true, recovery(reason))).toContain(SAFETY_HINT)
    })
  }

  test("a non-provider failure still uses the recovery message", () => {
    expect(haltInterruptionMessage(false, recovery("no_visible_output_or_tool_execution"))).toContain("Connection lost")
  })

  test("the provider_api_error reason has no override even without the rejection flag", () => {
    // Belt-and-suspenders: recoveryInterruptionMessage's switch also returns
    // undefined for "provider_api_error", so the two never disagree.
    expect(haltInterruptionMessage(false, recovery("provider_api_error"))).toBeUndefined()
  })

  test("undefined recovery yields no override", () => {
    expect(haltInterruptionMessage(true, undefined)).toBeUndefined()
    expect(haltInterruptionMessage(false, undefined)).toBeUndefined()
  })
})
