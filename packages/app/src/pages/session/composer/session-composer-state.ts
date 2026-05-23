import { createSessionBlockers } from "@/pages/session/blockers/use-session-blockers"

export function createSessionComposerState(input: { sessionID: () => string | undefined }) {
  const activeSessionID = input.sessionID
  const blockers = createSessionBlockers({ sessionID: activeSessionID })

  return {
    blocked: blockers.blocked,
    questionRequest: blockers.questionRequest,
    permissionRequest: blockers.permissionRequest,
    permissionResponding: blockers.permissionResponding,
    decide: blockers.decide,
  }
}

export type SessionComposerState = ReturnType<typeof createSessionComposerState>
