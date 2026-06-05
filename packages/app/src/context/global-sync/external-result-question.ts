import type { Part } from "@opencode-ai/sdk/v2/client"

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

export function upsertPendingExternalResultQuestion(
  list: PendingExternalResultQuestion[] | undefined,
  next: PendingExternalResultQuestion,
) {
  const current = list ?? []
  const index = current.findIndex((item) => item.id === next.id)
  if (index === -1) return [...current, next].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const out = current.slice()
  out[index] = next
  return out
}

export function removePendingExternalResultQuestion(
  list: PendingExternalResultQuestion[] | undefined,
  match: { id?: string; messageID?: string; partID?: string },
) {
  if (!list) return list
  const next = list.filter((item) => {
    const matches =
      (!match.id || item.id === match.id) &&
      (!match.partID || item.partID === match.partID) &&
      (!match.messageID || item.messageID === match.messageID)
    return !matches
  })
  return next.length > 0 ? next : undefined
}
