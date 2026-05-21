import type { UserMessage } from "@opencode-ai/sdk/v2"

export type TimelineVirtualMessageRow = {
  type: "message"
  key: `message:${string}`
  messageID: string
  message: UserMessage
  messageIndex: number
}

export type TimelineVirtualLoadEarlierRow = {
  type: "load-earlier"
  key: "history-load-earlier"
}

export type TimelineVirtualRow = TimelineVirtualLoadEarlierRow | TimelineVirtualMessageRow

export type TimelineRowMutation = "initial" | "same" | "prepend" | "append" | "replace"

export function createTimelineVirtualRows(input: {
  messages: readonly UserMessage[]
  historyMore: boolean
  turnStart: number
}): TimelineVirtualRow[] {
  const rows: TimelineVirtualRow[] = []

  if (input.turnStart > 0 || input.historyMore) {
    rows.push({ type: "load-earlier", key: "history-load-earlier" })
  }

  input.messages.forEach((message, messageIndex) => {
    rows.push({
      type: "message",
      key: `message:${message.id}`,
      messageID: message.id,
      message,
      messageIndex,
    })
  })

  return rows
}

function messageRows(rows: readonly TimelineVirtualRow[]) {
  return rows.filter((row): row is TimelineVirtualMessageRow => row.type === "message")
}

export function classifyTimelineRowMutation(input: {
  previous: readonly TimelineVirtualRow[]
  next: readonly TimelineVirtualRow[]
}): TimelineRowMutation {
  const previousMessages = messageRows(input.previous)
  const nextMessages = messageRows(input.next)

  if (previousMessages.length === 0) return nextMessages.length > 0 ? "initial" : "same"
  if (nextMessages.length === 0) return "replace"

  const previousFirst = previousMessages[0]?.messageID
  const previousLast = previousMessages.at(-1)?.messageID
  const nextFirst = nextMessages[0]?.messageID
  const nextLast = nextMessages.at(-1)?.messageID

  if (previousFirst === nextFirst && previousLast === nextLast && previousMessages.length === nextMessages.length) {
    return "same"
  }
  if (previousLast === nextLast && previousFirst !== nextFirst) return "prepend"
  if (previousFirst === nextFirst && previousLast !== nextLast) return "append"
  return "replace"
}
