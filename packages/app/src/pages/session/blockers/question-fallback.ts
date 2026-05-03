import type { Message, Part } from "@opencode-ai/sdk/v2"

export const QUESTION_FALLBACK_LOOKBACK_MESSAGES = 5

export function findRunningQuestionFallbackSession(input: {
  sessionID?: string
  hasQuestionRequest: boolean
  messages?: Message[]
  partsByMessageID: Record<string, Part[] | undefined>
  lookback?: number
}): string | undefined {
  if (!input.sessionID) return undefined
  if (input.hasQuestionRequest) return undefined
  const messages = input.messages
  if (!messages?.length) return undefined

  const lookback = input.lookback ?? QUESTION_FALLBACK_LOOKBACK_MESSAGES
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - lookback); i--) {
    const parts = input.partsByMessageID[messages[i].id]
    if (!parts) continue
    for (const part of parts) {
      if (part.type === "tool" && part.tool === "question" && part.state.status === "running") return input.sessionID
    }
  }

  return undefined
}
