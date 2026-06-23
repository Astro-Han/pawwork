import { describe, expect, test } from "bun:test"
import { haltInterruptionMessage } from "../../src/session/processor"
import type { RunObservability } from "../../src/session/run-observability"

type Recovery = NonNullable<RunObservability.Summary["incident"]>["recovery"]

// haltInterruptionMessage only reads recovery.reason; a minimal stub is enough.
function recovery(reason: NonNullable<Recovery>["reason"]): Recovery {
  return { reason } as unknown as Recovery
}

// Substring of the side-effect safety hint that must not be swallowed.
const SAFETY_HINT = "check whether the last operation completed"
const SIDE_EFFECT_REASONS = [
  "tool_execution_started",
  "unsafe_side_effect_started",
  "side_effect_facts_incomplete",
] as const

describe("haltInterruptionMessage", () => {
  test("a terminal provider API rejection (no side-effect risk) keeps its own message", () => {
    // reason "provider_api_error" only marks a terminal rejection with no side
    // effect (e.g. a 402 "Insufficient Balance" before any tool ran); its real
    // text must show, so return undefined and let halt() leave it in place — even
    // if a provider message is supplied.
    expect(haltInterruptionMessage(true, recovery("provider_api_error"))).toBeUndefined()
    expect(haltInterruptionMessage(true, recovery("provider_api_error"), "Insufficient Balance")).toBeUndefined()
  })

  // The P1 fix: a provider rejection that lands after a side effect (a terminal
  // rejection after a tool ran, OR a retryable rate_limit / server_overload that
  // exhausted retries) keeps BOTH the provider's real reason and the safety hint,
  // so a user who fixes balance/auth still checks external state before resending.
  for (const reason of SIDE_EFFECT_REASONS) {
    test(`a provider rejection with reason "${reason}" + provider message keeps both reason and hint`, () => {
      const message = haltInterruptionMessage(true, recovery(reason), "Insufficient Balance")
      expect(message).toContain("Insufficient Balance")
      expect(message).toContain(SAFETY_HINT)
      // The bare hint is used, not the "Connection lost." framing that would
      // mislabel a billing/auth rejection.
      expect(message).not.toContain("Connection lost")
    })

    test(`a provider rejection with reason "${reason}" but no provider message still keeps the hint`, () => {
      // Fallback when no provider text is available: the recovery string still
      // carries the hint (the safety warning is never dropped).
      expect(haltInterruptionMessage(true, recovery(reason))).toContain(SAFETY_HINT)
    })
  }

  test("a non-provider failure uses the recovery message verbatim", () => {
    expect(haltInterruptionMessage(false, recovery("no_visible_output_or_tool_execution"))).toContain("Connection lost")
  })

  test("the provider_api_error reason has no override even without the rejection flag", () => {
    // Belt-and-suspenders: recoveryInterruptionMessage's switch also returns
    // undefined for "provider_api_error", so the two never disagree.
    expect(haltInterruptionMessage(false, recovery("provider_api_error"))).toBeUndefined()
  })

  test("undefined recovery yields no override", () => {
    expect(haltInterruptionMessage(true, undefined)).toBeUndefined()
    expect(haltInterruptionMessage(true, undefined, "Insufficient Balance")).toBeUndefined()
    expect(haltInterruptionMessage(false, undefined)).toBeUndefined()
  })
})
