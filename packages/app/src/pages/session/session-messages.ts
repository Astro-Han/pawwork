import type { Message, UserMessage } from "@opencode-ai/sdk/v2/client"

export const emptyMessages = Object.freeze([]) as unknown as Message[]
export const emptyUserMessages = Object.freeze([]) as unknown as UserMessage[]

export function readSessionMessages(value: unknown): Message[] {
  return Array.isArray(value) ? (value as Message[]) : emptyMessages
}

function isUserMessage(value: unknown): value is UserMessage {
  return !!value && typeof value === "object" && "role" in value && value.role === "user"
}

export function readUserMessages(messages: unknown): UserMessage[] {
  if (!Array.isArray(messages)) return emptyUserMessages
  const users = messages.filter(isUserMessage)
  return users.length > 0 ? users : emptyUserMessages
}
