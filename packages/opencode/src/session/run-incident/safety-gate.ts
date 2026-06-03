import type { RecoveryDecision } from "./types"

export type ReplaySafetyDecision = {
  canReplay: boolean
  recoveryMode: "replay" | "auto_replay_blocked" | "ask_user" | "offer_continue" | "stop"
  blockedReason?: "safe_recovery_budget_exhausted" | RecoveryDecision["reason"]
}

export function evaluateReplaySafety(input: {
  recovery: RecoveryDecision
  safeRecoveryAttempt: number
}): ReplaySafetyDecision {
  const safety = input.recovery

  if (safety.recommendation === "auto_retry") {
    const maxAttempts = safety.auto_retry?.max_attempts ?? 1
    if (input.safeRecoveryAttempt < maxAttempts) {
      return {
        canReplay: true,
        recoveryMode: "replay",
      }
    }
    return {
      canReplay: false,
      recoveryMode: "auto_replay_blocked",
      blockedReason: "safe_recovery_budget_exhausted",
    }
  }

  if (safety.recommendation === "offer_continue") {
    return {
      canReplay: false,
      recoveryMode: "offer_continue",
      blockedReason: safety.reason,
    }
  }

  if (
    safety.recommendation === "ask_user_before_retry" ||
    safety.recommendation === "offer_resume_with_confirmation"
  ) {
    return {
      canReplay: false,
      recoveryMode: "ask_user",
      blockedReason: safety.reason,
    }
  }

  return {
    canReplay: false,
    recoveryMode: "stop",
    blockedReason: safety.reason,
  }
}
