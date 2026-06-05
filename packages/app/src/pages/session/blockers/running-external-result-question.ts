import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import type { PendingExternalResultQuestion, QuestionInfo } from "@/context/global-sync/external-result-question"

export type { QuestionInfo }

/**
 * Dock request shape: a synthetic representation of a running question tool
 * part. The dock branches its submit handler on the presence of messageID and
 * callID; this matches the route at POST /session/:sessionID/tool/respond.
 */
export type DockQuestionRequest = PendingExternalResultQuestion

function isKnownStalePendingQuestion(input: {
  pending: DockQuestionRequest
  partsByMessageID: { [messageID: string]: Part[] | undefined }
}) {
  const part = input.partsByMessageID[input.pending.messageID]?.find((item) => item.id === input.pending.partID)
  // If the part never reached the local cache, keep the index entry; bootstrap
  // prune reconciles already-answered questions whose terminal event was missed.
  if (!part) return false
  if (part.type !== "tool") return true
  if (part.tool !== "question") return true
  if (part.state.status !== "running") return true
  if (part.state.metadata?.externalResultReady !== true) return true
  const partInput = part.state.input as { questions?: QuestionInfo[] } | undefined
  return !Array.isArray(partInput?.questions) || partInput.questions.length === 0
}

/**
 * Selector: find the first running `question` tool part for the active session
 * whose `state.metadata.externalResultReady === true`. The `=== true` check is
 * load-bearing — the writer in `packages/opencode/src/session/prompt.ts` sets
 * the flag AFTER the registry Deferred is registered, so dropping the check
 * would let the dock render before the route can resolve and surface a 404 on
 * fast submits.
 */
export function findRunningExternalResultQuestion(input: {
  sessionID: string
  messages: Message[] | undefined
  partsByMessageID: { [messageID: string]: Part[] | undefined }
}): DockQuestionRequest | undefined {
  const { sessionID, messages, partsByMessageID } = input
  if (!messages) return undefined
  for (const message of messages) {
    const parts = partsByMessageID[message.id]
    if (!parts) continue
    for (const part of parts) {
      if (part.type !== "tool") continue
      if (part.tool !== "question") continue
      if (part.state.status !== "running") continue
      const metadata = part.state.metadata
      if (!metadata || metadata.externalResultReady !== true) continue
      const partInput = part.state.input as { questions?: QuestionInfo[] } | undefined
      // Skip malformed snapshots: an empty questions array would render an
      // empty dock that can only submit `payload.answers: []`, which the
      // server decoder rejects as count mismatch. Ignore until the snapshot
      // arrives intact.
      if (!Array.isArray(partInput?.questions) || partInput!.questions.length === 0) continue
      return {
        id: `${part.messageID}:${part.callID}`,
        sessionID,
        questions: partInput!.questions,
        messageID: part.messageID,
        callID: part.callID,
        partID: part.id,
      }
    }
  }
  return undefined
}

/**
 * Walks the session tree (root + descendants) and returns the first running
 * external-result question. Used by both the dock (so a parent session page
 * surfaces a child agent question) and the sidebar "asking" pip (so the two
 * stay in lock-step). The returned `sessionID` points at the session that
 * actually owns the running tool part, so /tool/respond hits the correct
 * Deferred.
 */
export function findDescendantExternalResultQuestion(input: {
  sessions: Session[]
  rootSessionID: string
  pendingQuestions?: { [sessionID: string]: DockQuestionRequest[] | undefined }
  messages: { [sessionID: string]: Message[] | undefined }
  partsByMessageID: { [messageID: string]: Part[] | undefined }
}): DockQuestionRequest | undefined {
  const { sessions, rootSessionID, pendingQuestions, messages, partsByMessageID } = input
  const childMap = sessions.reduce((acc, item) => {
    if (!item.parentID) return acc
    const list = acc.get(item.parentID)
    if (list) list.push(item.id)
    else acc.set(item.parentID, [item.id])
    return acc
  }, new Map<string, string[]>())

  const seen = new Set([rootSessionID])
  const stack = [rootSessionID]
  while (stack.length > 0) {
    const sid = stack.pop()!
    const pending = pendingQuestions?.[sid]?.find(
      (item) => !isKnownStalePendingQuestion({ pending: item, partsByMessageID }),
    )
    if (pending) return pending
    const found = findRunningExternalResultQuestion({
      sessionID: sid,
      messages: messages[sid],
      partsByMessageID,
    })
    if (found) return found
    const children = childMap.get(sid)
    if (!children) continue
    for (const child of children) {
      if (seen.has(child)) continue
      seen.add(child)
      stack.push(child)
    }
  }
  return undefined
}
