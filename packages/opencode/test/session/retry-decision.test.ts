import { describe, expect, test } from "bun:test"
import { buildModelRetryDecision } from "../../src/session/retry-decision"
import type { RunIncident } from "../../src/session/run-incident"

const safeReplayGate: RunIncident.Recovery = {
  recommendation: "auto_retry_once",
  confidence: "high",
  reason: "reasoning_only_without_final_text_or_tool_activity",
  auto_retry: { max_attempts: 1, backoff_ms: 1_000 },
  safety_scope: "visible_output_and_tool_side_effects",
}

describe("session.retry-decision", () => {
  test("keeps technical retryability separate from safe recovery replay metadata", () => {
    const decision = buildModelRetryDecision({
      technicalRetryability: { retryable: true, message: "Connection timed out" },
      safetyGateDecision: safeReplayGate,
      providerRetryAttempt: 3,
      safeRecoveryAttempt: 0,
      timeoutPolicy: "reasoning_first_attempt",
    })

    expect(decision).toMatchObject({
      canRetry: true,
      recoveryMode: "replay",
      attemptKind: "safe_recovery_replay",
      providerRetryAttempt: 3,
      safeRecoveryAttempt: 0,
      timeoutPolicy: "reasoning_first_attempt",
      presentation: "safe_recovery",
    })
    expect(decision.blockedReason).toBeUndefined()
    expect(decision.technicalRetryability.retryable).toBe(true)
    expect(decision.safetyGateDecision.reason).toBe("reasoning_only_without_final_text_or_tool_activity")
  })

  test("blocks automatic replay when the safe recovery budget is exhausted", () => {
    const decision = buildModelRetryDecision({
      technicalRetryability: { retryable: true, message: "Connection timed out" },
      safetyGateDecision: safeReplayGate,
      providerRetryAttempt: 3,
      safeRecoveryAttempt: 1,
      timeoutPolicy: "reasoning_safe_recovery",
    })

    expect(decision).toMatchObject({
      canRetry: false,
      recoveryMode: "auto_replay_blocked",
      attemptKind: "safe_recovery_replay",
      providerRetryAttempt: 3,
      safeRecoveryAttempt: 1,
      timeoutPolicy: "reasoning_safe_recovery",
      presentation: "safe_recovery_failed",
      blockedReason: "safe_recovery_budget_exhausted",
    })
  })

  test("does not ask the safety gate to own terminal technical classification", () => {
    const decision = buildModelRetryDecision({
      technicalRetryability: { retryable: false, reason: "terminal_classification" },
      safetyGateDecision: safeReplayGate,
      providerRetryAttempt: 1,
      safeRecoveryAttempt: 0,
      timeoutPolicy: "default",
    })

    expect(decision).toMatchObject({
      canRetry: false,
      recoveryMode: "stop",
      blockedReason: "terminal_classification",
      presentation: "default",
    })
    expect(decision.safetyGateDecision).toBe(safeReplayGate)
  })
})
