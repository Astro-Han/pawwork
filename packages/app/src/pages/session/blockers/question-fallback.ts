import type { Message, Part } from "@opencode-ai/sdk/v2"

// Minimal sync-entry shape this matcher needs. Widened from the full
// QuestionRequest so callers (e.g. reverify) can pass narrower generics
// without `as never` while keeping QuestionRequest[] callers happy via
// structural subtyping.
export interface QuestionFallbackEntry {
  tool?: { messageID: string; callID: string }
}

// Triggers fallback recovery when a running question tool part on this session
// has no matching entry in sync. Identity is (messageID, callID) so a model
// emitting parallel question tool calls is covered correctly even when the
// counts happen to line up but the entries point to different tool calls.
//
// Sync entries that lack tool identity (e.g. legacy / seeded test fixtures)
// can't be matched by key, so they cover any one running part. The
// uncovered-with-identity bucket and the without-identity bucket are pooled
// against the entries-without-identity bucket: a fallback only fires when
// the uncovered total truly exceeds what the legacy entries can absorb.
// See #419.
export function findRunningQuestionFallbackSession(input: {
  sessionID?: string
  syncQuestions: ReadonlyArray<QuestionFallbackEntry>
  messages?: ReadonlyArray<Message>
  partsByMessageID: Record<string, ReadonlyArray<Part> | undefined>
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

  let uncoveredRunning = 0
  for (const m of messages) {
    const parts = input.partsByMessageID[m.id]
    if (!parts) continue
    for (const part of parts) {
      if (part.type !== "tool" || part.tool !== "question" || part.state.status !== "running") continue
      const callID = part.callID
      const messageID = part.messageID
      if (!callID || !messageID || !coveredKeys.has(`${messageID}:${callID}`)) {
        uncoveredRunning++
      }
    }
  }

  if (uncoveredRunning > entriesWithoutTool) return input.sessionID
  return undefined
}
