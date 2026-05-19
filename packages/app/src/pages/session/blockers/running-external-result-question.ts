import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"

// QuestionInfo / QuestionRequest used to live in @opencode-ai/sdk/v2 when the
// question tool was driven by a dedicated server route. The external-result
// migration deleted those exports; define the dock-facing shapes locally.
export type QuestionInfo = {
  question: string
  header?: string
  options?: ReadonlyArray<{ label: string; description?: string }>
  multiple?: boolean
  custom?: boolean
}

/**
 * Dock request shape: a synthetic representation of a running question tool
 * part. The dock branches its submit handler on the presence of messageID and
 * callID; this matches the route at POST /session/:sessionID/tool/respond.
 */
export type DockQuestionRequest = {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  messageID: string
  callID: string
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
      const questions: QuestionInfo[] = Array.isArray(partInput?.questions) ? partInput!.questions : []
      return {
        id: `${part.messageID}:${part.callID}`,
        sessionID,
        questions,
        messageID: part.messageID,
        callID: part.callID,
      }
    }
  }
  return undefined
}

/**
 * Sidebar helper: returns true when the given session OR any descendant session
 * has a running external-result question part. Mirrors the dock selector used
 * by use-session-blockers; the sidebar "asking" pip must match dock visibility
 * across child agent sessions.
 */
export function anyDescendantExternalResultQuestion(input: {
  sessions: Session[]
  rootSessionID: string
  messages: { [sessionID: string]: Message[] | undefined }
  partsByMessageID: { [messageID: string]: Part[] | undefined }
}): boolean {
  const { sessions, rootSessionID, messages, partsByMessageID } = input
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
    const found = findRunningExternalResultQuestion({
      sessionID: sid,
      messages: messages[sid],
      partsByMessageID,
    })
    if (found) return true
    const children = childMap.get(sid)
    if (!children) continue
    for (const child of children) {
      if (seen.has(child)) continue
      seen.add(child)
      stack.push(child)
    }
  }
  return false
}
