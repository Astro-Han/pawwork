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

export function messagesBeforeID<T extends { id: string }>(messages: T[], boundaryID?: string): T[] {
  if (!boundaryID) return messages
  const index = messages.findIndex((message) => message.id === boundaryID)
  return index >= 0 ? messages.slice(0, index) : []
}

export function userMessagesBeforeID(messages: Message[], boundaryID?: string): UserMessage[] {
  return readUserMessages(messagesBeforeID(messages, boundaryID))
}

export function userMessageBeforeID(messages: Message[], messageID: string): UserMessage | undefined {
  return readUserMessages(messagesBeforeID(messages, messageID)).at(-1)
}

export function userMessageAfterID(messages: Message[], messageID: string): UserMessage | undefined {
  const index = messages.findIndex((message) => message.id === messageID)
  if (index < 0) return
  return messages.slice(index + 1).find(isUserMessage)
}

export function buildTurnMessagesByUserID(messages: readonly Message[]) {
  const result = new Map<string, AssistantMessage[]>()
  const seenUserIDs = new Set<string>()

  for (const message of messages) {
    if (isUserMessage(message)) {
      seenUserIDs.add(message.id)
      continue
    }

    if (!isAssistantMessage(message) || !message.parentID || !seenUserIDs.has(message.parentID)) continue
    let assistants = result.get(message.parentID)
    if (!assistants) {
      assistants = []
      result.set(message.parentID, assistants)
    }
    assistants.push(message)
  }

  return result
}
