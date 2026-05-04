import type { Message, Part, QuestionRequest } from "@opencode-ai/sdk/v2"
import { findRunningQuestionFallbackSession } from "./question-fallback"

export type QuestionRecoverySnapshot =
  | { kind: "none" }
  | { kind: "ready" }
  | { kind: "missingRunning" }

export interface ResolveSnapshotInput {
  sessionID: string | undefined
  sessionTreeQuestionRequest: unknown
  activeSessionSyncQuestions: ReadonlyArray<QuestionRequest>
  activeSessionMessages: Message[] | undefined
  partsByMessageID: Record<string, Part[] | undefined>
}

// Pure reducer: drives the auto-heal clock. Delegates missingRunning detection
// to findRunningQuestionFallbackSession so identity matching + legacy bucket
// pooling stay in lockstep with the existing fallback (#419 / PR #430).
export function resolveQuestionRecoverySnapshot(input: ResolveSnapshotInput): QuestionRecoverySnapshot {
  if (!input.sessionID) return { kind: "none" }
  if (input.sessionTreeQuestionRequest) return { kind: "ready" }

  const fallbackSessionID = findRunningQuestionFallbackSession({
    sessionID: input.sessionID,
    syncQuestions: input.activeSessionSyncQuestions,
    messages: input.activeSessionMessages,
    partsByMessageID: input.partsByMessageID,
  })
  if (fallbackSessionID === input.sessionID) return { kind: "missingRunning" }
  return { kind: "none" }
}
