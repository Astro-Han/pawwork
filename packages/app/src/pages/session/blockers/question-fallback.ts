import type { Message, Part, QuestionRequest } from "@opencode-ai/sdk/v2"

// Triggers fallback recovery when a running question tool part on this session
// has no matching entry in sync. Identity is (messageID, callID) so a model
// emitting parallel question tool calls is covered correctly even when the
// counts happen to line up but the entries point to different tool calls.
// Falls back to a count check for the rare entries that lack tool identity
// (e.g. seeded test fixtures), so head-count loss is still caught. See #419.
export function findRunningQuestionFallbackSession(input: {
  sessionID?: string
  syncQuestions: ReadonlyArray<QuestionRequest>
  messages?: Message[]
  partsByMessageID: Record<string, Part[] | undefined>
}): string | undefined {
  if (!input.sessionID) return undefined
  const messages = input.messages
  if (!messages?.length) return undefined

  const coveredKeys = new Set<string>()
  let entriesWithoutTool = 0
  for (const q of input.syncQuestions) {
    if (q.tool) coveredKeys.add(`${q.tool.messageID}:${q.tool.callID}`)
    else entriesWithoutTool++
  }

  let runningWithoutTool = 0
  for (const m of messages) {
    const parts = input.partsByMessageID[m.id]
    if (!parts) continue
    for (const part of parts) {
      if (part.type !== "tool" || part.tool !== "question" || part.state.status !== "running") continue
      const callID = part.callID
      const messageID = part.messageID
      if (!callID || !messageID) {
        runningWithoutTool++
        continue
      }
      if (!coveredKeys.has(`${messageID}:${callID}`)) return input.sessionID
    }
  }

  if (runningWithoutTool > entriesWithoutTool) return input.sessionID
  return undefined
}
