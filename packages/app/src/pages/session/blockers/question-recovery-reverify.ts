import type { ReverifyContext, ReverifyOutcome } from "./question-recovery-clock"
import type { QuestionRecoverySnapshot } from "./question-recovery-snapshot"
import { findRunningQuestionFallbackSession } from "./question-fallback"

export interface ReverifyDeps<Q> {
  snapshot: () => QuestionRecoverySnapshot
  activeSessionID: () => string | undefined
  activeDirectory: () => string
  isSessionBusy: (sessionID: string) => boolean
  listQuestions: () => Promise<readonly Q[]>
  partsByMessageID: () => Record<string, ReadonlyArray<unknown>>
  messagesFor: (sessionID: string) => unknown
  applyHydration: (sessionID: string, questions: readonly Q[]) => void
  warn?: (message: string, payload: Record<string, unknown>) => void
}

// Reverify glue used by `createSessionBlockers`. Lives here as a pure
// function so it can be unit-tested without standing up the full provider
// tree (sdk + sync + permission + language). The four guards run in order:
//   1. snapshot still missingRunning
//   2. active session and directory unchanged since arm
//   3. session still busy
//   4. server confirms the running question part is still uncovered
// Transient list() failures ask the clock for one bounded follow-up.
export async function questionRecoveryReverify<
  Q extends { sessionID: string; tool?: { messageID: string; callID: string }; id?: string },
>(deps: ReverifyDeps<Q>, sessionID: string, ctx: ReverifyContext): Promise<ReverifyOutcome> {
  const localGuards = () => {
    if (deps.snapshot().kind !== "missingRunning") return false
    if (deps.activeSessionID() !== sessionID) return false
    if (deps.activeDirectory() !== ctx.armedDirectory) return false
    if (!deps.isSessionBusy(sessionID)) return false
    return true
  }
  if (!localGuards()) return { proceed: false }

  let filtered: readonly Q[]
  try {
    const all = await deps.listQuestions()
    filtered = all.filter((q) => q.sessionID === sessionID)
  } catch (err) {
    deps.warn?.("question-recovery: question.list() failed", { sessionID, err })
    return { proceed: false, retry: true }
  }

  if (!localGuards()) return { proceed: false }

  const stillUncovered = findRunningQuestionFallbackSession({
    sessionID,
    syncQuestions: filtered,
    messages: deps.messagesFor(sessionID) as never,
    partsByMessageID: deps.partsByMessageID() as never,
  })
  if (stillUncovered === sessionID) return { proceed: true }

  deps.applyHydration(sessionID, filtered)
  return { proceed: false }
}
