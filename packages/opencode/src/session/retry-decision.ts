import type { RunIncident } from "./run-incident"
import type { RetryClassification } from "./retry-classification"

export type TechnicalRetryability =
  | {
      retryable: true
      classification?: RetryClassification
      message?: string
    }
  | {
      retryable: false
      classification?: RetryClassification
      reason: "not_retryable" | "terminal_classification"
    }

export type RetryAttemptKind = "provider_retry" | "safe_recovery_replay"
export type RecoveryMode = "replay" | "auto_replay_blocked" | "ask_user" | "offer_continue" | "stop"
export type RetryTimeoutPolicy =
  | "default"
  | "reasoning_global_protected"
  | "reasoning_first_attempt"
  | "reasoning_safe_recovery"
export type RetryPresentation = "default" | "safe_recovery" | "safe_recovery_failed"
export type RetryBlockedReason =
  | "technical_not_retryable"
  | "terminal_classification"
  | "safe_recovery_budget_exhausted"
  | RunIncident.Recovery["reason"]

export type ModelRetryDecision = {
  technicalRetryability: TechnicalRetryability
  safetyGateDecision: RunIncident.Recovery
  canRetry: boolean
  recoveryMode: RecoveryMode
  blockedReason?: RetryBlockedReason
  attemptKind?: RetryAttemptKind
  modelStreamAttempt: number
  safeRecoveryAttempt: number
  timeoutPolicy: RetryTimeoutPolicy
  presentation: RetryPresentation
}

export function selectRetryTimeoutPolicy(input: {
  modelSupportsReasoning: boolean
  explicitConnectTimeout: boolean
  beforeProgressAutoRetryAllowed: boolean
  safeRecoveryAttempt: number
}): RetryTimeoutPolicy {
  if (input.explicitConnectTimeout) return "default"
  if (!input.modelSupportsReasoning) return "default"
  if (input.safeRecoveryAttempt > 0) return "reasoning_safe_recovery"
  return input.beforeProgressAutoRetryAllowed ? "reasoning_first_attempt" : "reasoning_global_protected"
}

export function buildModelRetryDecision(input: {
  technicalRetryability: TechnicalRetryability
  safetyGateDecision: RunIncident.Recovery
  modelStreamAttempt: number
  safeRecoveryAttempt: number
  timeoutPolicy: RetryTimeoutPolicy
}): ModelRetryDecision {
  if (!input.technicalRetryability.retryable) {
    return {
      ...input,
      canRetry: false,
      recoveryMode: "stop",
      blockedReason:
        input.technicalRetryability.reason === "terminal_classification"
          ? "terminal_classification"
          : "technical_not_retryable",
      presentation: "default",
    }
  }

  const safety = input.safetyGateDecision
  if (safety.recommendation === "auto_retry_once") {
    const maxAttempts = safety.auto_retry?.max_attempts ?? 1
    if (input.safeRecoveryAttempt < maxAttempts) {
      return {
        ...input,
        canRetry: true,
        recoveryMode: "replay",
        attemptKind: "safe_recovery_replay",
        presentation: "safe_recovery",
      }
    }
    return {
      ...input,
      canRetry: false,
      recoveryMode: "auto_replay_blocked",
      blockedReason: "safe_recovery_budget_exhausted",
      attemptKind: "safe_recovery_replay",
      presentation: "safe_recovery_failed",
    }
  }

  if (safety.recommendation === "offer_continue") {
    return {
      ...input,
      canRetry: false,
      recoveryMode: "offer_continue",
      blockedReason: safety.reason,
      presentation: "default",
    }
  }

  if (
    safety.recommendation === "ask_user_before_retry" ||
    safety.recommendation === "offer_resume_with_confirmation"
  ) {
    return {
      ...input,
      canRetry: false,
      recoveryMode: "ask_user",
      blockedReason: safety.reason,
      presentation: "default",
    }
  }

  return {
    ...input,
    canRetry: false,
    recoveryMode: "stop",
    blockedReason: safety.reason,
    presentation: "default",
  }
}
