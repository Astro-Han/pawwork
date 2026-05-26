import { describe, expect, test } from "bun:test"
import { buildModelRetryDecision, selectRetryTimeoutPolicy } from "../../src/session/retry-decision"
import type { RunIncident } from "../../src/session/run-incident"

const safeReplayGate: RunIncident.Recovery = {
  recommendation: "auto_retry_once",
  confidence: "high",
  reason: "reasoning_only_without_final_text_or_tool_activity",
  auto_retry: { max_attempts: 1, backoff_ms: 1_000 },
  safety_scope: "visible_output_and_tool_side_effects",
}

const visibleOutputGate: RunIncident.Recovery = {
  recommendation: "offer_continue",
  confidence: "high",
  reason: "visible_output_without_tool_execution",
  safety_scope: "visible_output_and_tool_side_effects",
}

const ambiguousToolGate: RunIncident.Recovery = {
  recommendation: "ask_user_before_retry",
  confidence: "high",
  reason: "side_effect_facts_incomplete",
  safety_scope: "visible_output_and_tool_side_effects",
}

describe("session.retry-decision", () => {
  test("keeps technical retryability separate from safe recovery replay metadata", () => {
    const decision = buildModelRetryDecision({
      technicalRetryability: { retryable: true, message: "Connection timed out" },
      safetyGateDecision: safeReplayGate,
      modelStreamAttempt: 3,
      safeRecoveryAttempt: 0,
      timeoutPolicy: "reasoning_first_attempt",
    })

    expect(decision).toMatchObject({
      canRetry: true,
      recoveryMode: "replay",
      attemptKind: "safe_recovery_replay",
      modelStreamAttempt: 3,
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
      modelStreamAttempt: 3,
      safeRecoveryAttempt: 1,
      timeoutPolicy: "reasoning_safe_recovery",
    })

    expect(decision).toMatchObject({
      canRetry: false,
      recoveryMode: "auto_replay_blocked",
      attemptKind: "safe_recovery_replay",
      modelStreamAttempt: 3,
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
      modelStreamAttempt: 1,
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

  test("represents continuation offers without treating them as replay", () => {
    const decision = buildModelRetryDecision({
      technicalRetryability: { retryable: true, message: "socket closed" },
      safetyGateDecision: visibleOutputGate,
      modelStreamAttempt: 2,
      safeRecoveryAttempt: 0,
      timeoutPolicy: "default",
    })

    expect(decision).toMatchObject({
      canRetry: false,
      recoveryMode: "offer_continue",
      blockedReason: "visible_output_without_tool_execution",
      presentation: "default",
    })
    expect(decision.attemptKind).toBeUndefined()
  })

  test("represents safety-confirmation gates without consuming the replay budget", () => {
    const decision = buildModelRetryDecision({
      technicalRetryability: { retryable: true, message: "socket closed" },
      safetyGateDecision: ambiguousToolGate,
      modelStreamAttempt: 2,
      safeRecoveryAttempt: 0,
      timeoutPolicy: "default",
    })

    expect(decision).toMatchObject({
      canRetry: false,
      recoveryMode: "ask_user",
      blockedReason: "side_effect_facts_incomplete",
      safeRecoveryAttempt: 0,
      presentation: "default",
    })
    expect(decision.attemptKind).toBeUndefined()
  })

  test("marks blocked-boundary reasoning first attempts as global protected timeout", () => {
    const timeoutPolicy = selectRetryTimeoutPolicy({
      modelSupportsReasoning: true,
      explicitConnectTimeout: false,
      beforeProgressAutoRetryAllowed: false,
      safeRecoveryAttempt: 0,
    })

    expect(timeoutPolicy).toBe("reasoning_global_protected")
  })
})
