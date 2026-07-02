import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"

export type QuestionInfo = {
  question: string
  header?: string
  options?: ReadonlyArray<{ label: string; description?: string }>
  multiple?: boolean
  custom?: boolean
}

export type PendingExternalResultQuestion = {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  messageID: string
  callID: string
  partID: string
}

export function pendingExternalResultQuestionFromPart(part: Part): PendingExternalResultQuestion | undefined {
  if (part.type !== "tool") return undefined
  if (part.tool !== "question") return undefined
  if (part.state.status !== "running") return undefined
  if (part.state.metadata?.externalResultReady !== true) return undefined
  if (!part.sessionID || !part.messageID || !part.callID || !part.id) return undefined
  const partInput = part.state.input as { questions?: QuestionInfo[] } | undefined
  if (!Array.isArray(partInput?.questions) || partInput.questions.length === 0) return undefined
  return {
    id: `${part.messageID}:${part.callID}`,
    sessionID: part.sessionID,
    questions: partInput.questions,
    messageID: part.messageID,
    callID: part.callID,
    partID: part.id,
  }
}

/**
 * Dock request shape: a synthetic representation of a running question tool
 * part. The dock branches its submit handler on the presence of messageID and
 * callID; this matches the route at POST /session/:sessionID/tool/respond.
 */
export type DockQuestionRequest = PendingExternalResultQuestion

export function findRunningExternalResultQuestion(input: {
  sessionID: string
  messages: readonly Message[] | undefined
  partsByMessageID: { [messageID: string]: readonly Part[] | undefined }
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
      if (part.state.metadata?.externalResultReady !== true) continue
      if (!part.messageID || !part.callID || !part.id) continue
      const partInput = part.state.input as { questions?: QuestionInfo[] } | undefined
      if (!Array.isArray(partInput?.questions) || partInput.questions.length === 0) continue
      return {
        id: `${part.messageID}:${part.callID}`,
        sessionID,
        questions: partInput.questions,
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
 * external-result question for render surfaces backed by the part cache.
 */
export function findDescendantExternalResultQuestion(input: {
  sessions: readonly Session[]
  rootSessionID: string
  messages: { [sessionID: string]: readonly Message[] | undefined }
  partsByMessageID: { [messageID: string]: readonly Part[] | undefined }
}): DockQuestionRequest | undefined {
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

export function rootSessionIDsWithDescendantExternalResultQuestions(input: {
  sessions: readonly Session[]
  messages: { [sessionID: string]: readonly Message[] | undefined }
  partsByMessageID: { [messageID: string]: readonly Part[] | undefined }
}): Set<string> {
  const roots = new Set<string>()
  for (const session of input.sessions) {
    if (session.parentID) continue
    const found = findDescendantExternalResultQuestion({
      sessions: input.sessions,
      rootSessionID: session.id,
      messages: input.messages,
      partsByMessageID: input.partsByMessageID,
    })
    if (found) roots.add(session.id)
  }
  return roots
}
