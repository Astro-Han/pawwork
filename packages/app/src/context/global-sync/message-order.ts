export type OrderedMessage = {
  id: string
  time?: {
    created?: number
  }
}

const createdAt = (message: OrderedMessage) => {
  const created = message.time?.created
  return typeof created === "number" && Number.isFinite(created) ? created : 0
}

export function compareMessagesByCreated(a: OrderedMessage, b: OrderedMessage) {
  const created = createdAt(a) - createdAt(b)
  if (created !== 0) return created
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function mergeMessagesByCreated<T extends OrderedMessage>(current: readonly T[], incoming: readonly T[]) {
  const messages = new Map(current.map((message) => [message.id, message] as const))
  for (const message of incoming) messages.set(message.id, message)
  return [...messages.values()].sort(compareMessagesByCreated)
}

export function upsertMessageByCreated<T extends OrderedMessage>(messages: readonly T[], message: T) {
  return mergeMessagesByCreated(
    messages.filter((item) => item.id !== message.id),
    [message],
  )
}
