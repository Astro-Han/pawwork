import type { Message, Part, QuestionInfo, QuestionRequest } from "@opencode-ai/sdk/v2/client"

/**
 * Dock request shape: extends the legacy `QuestionRequest` with optional
 * `messageID` / `callID` for the new external-result path. Presence of those
 * fields means "respond via POST /session/:sessionID/tool/respond"; absence
 * means "legacy `sdk.client.question.reply` / `.reject`".
 */
export type DockQuestionRequest = QuestionRequest & {
  messageID?: string
  callID?: string
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
