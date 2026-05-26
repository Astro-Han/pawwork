import { describe, expect, test } from "bun:test"
import { RunIncident } from "../../src/session/run-incident"

const base = {
  confidence: "high",
  safety_scope: "visible_output_and_tool_side_effects",
} as const

describe("run incident safety gate", () => {
  test("allows one automatic replay for safe recovery decisions", () => {
    const decision = RunIncident.evaluateReplaySafety({
      recovery: {
        ...base,
        recommendation: "auto_retry_once",
        reason: "reasoning_only_without_final_text_or_tool_activity",
        auto_retry: { max_attempts: 1, backoff_ms: 1_000 },
      },
      safeRecoveryAttempt: 0,
    })

    expect(decision).toMatchObject({
      canReplay: true,
      recoveryMode: "replay",
    })
    expect(decision.blockedReason).toBeUndefined()
  })

  test("blocks automatic replay after the safe recovery budget is exhausted", () => {
    const decision = RunIncident.evaluateReplaySafety({
      recovery: {
        ...base,
        recommendation: "auto_retry_once",
        reason: "no_visible_output_or_tool_execution",
        auto_retry: { max_attempts: 1, backoff_ms: 1_000 },
      },
      safeRecoveryAttempt: 1,
    })

    expect(decision).toMatchObject({
      canReplay: false,
      recoveryMode: "auto_replay_blocked",
      blockedReason: "safe_recovery_budget_exhausted",
    })
  })

  test("keeps visible-output recovery as continuation instead of replay", () => {
    const decision = RunIncident.evaluateReplaySafety({
      recovery: {
        ...base,
        recommendation: "offer_continue",
        reason: "visible_output_without_tool_execution",
      },
      safeRecoveryAttempt: 0,
    })

    expect(decision).toMatchObject({
      canReplay: false,
      recoveryMode: "offer_continue",
      blockedReason: "visible_output_without_tool_execution",
    })
  })

  test("blocks replay and requires user confirmation for ambiguous retry safety", () => {
    for (const recommendation of ["ask_user_before_retry", "offer_resume_with_confirmation"] as const) {
      const decision = RunIncident.evaluateReplaySafety({
        recovery: {
          ...base,
          recommendation,
          reason: "tool_call_materialized_without_execution",
        },
        safeRecoveryAttempt: 0,
      })

      expect(decision).toMatchObject({
        canReplay: false,
        recoveryMode: "ask_user",
        blockedReason: "tool_call_materialized_without_execution",
      })
    }
  })
})
