import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2/client"

export const emptyMessages = Object.freeze([]) as unknown as Message[]
export const emptyUserMessages = Object.freeze([]) as unknown as UserMessage[]
export const emptyAssistantMessages = Object.freeze([]) as unknown as AssistantMessage[]

export function readSessionMessages(value: unknown): Message[] {
  return Array.isArray(value) ? (value as Message[]) : emptyMessages
}

function isUserMessage(value: unknown): value is UserMessage {
  return !!value && typeof value === "object" && "role" in value && value.role === "user"
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return !!value && typeof value === "object" && "role" in value && value.role === "assistant"
}

export function readUserMessages(messages: unknown): UserMessage[] {
  if (!Array.isArray(messages)) return emptyUserMessages
  const users = messages.filter(isUserMessage)
  return users.length > 0 ? users : emptyUserMessages
}

export function buildTurnMessagesByUserID(messages: readonly Message[]) {
  const result = new Map<string, AssistantMessage[]>()

  for (const message of messages) {
    if (isUserMessage(message)) {
      if (!result.has(message.id)) result.set(message.id, [])
      continue
    }

    if (!isAssistantMessage(message) || !message.parentID) continue
    const assistants = result.get(message.parentID)
    if (assistants) assistants.push(message)
  }

  return result
}
