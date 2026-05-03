import type { Event } from "@opencode-ai/sdk/v2/client"

export type QueuedGlobalEvent = { directory: string; payload: Event }

const deltaKey = (event: QueuedGlobalEvent) => {
  if (event.payload.type !== "message.part.delta") return
  const props = event.payload.properties
  return `${event.directory}:${props.messageID}:${props.partID}:${props.field}`
}

const partKey = (event: QueuedGlobalEvent) => {
  if (event.payload.type === "message.part.delta") {
    const props = event.payload.properties
    return `${event.directory}:${props.messageID}:${props.partID}`
  }
  if (event.payload.type === "message.part.updated") {
    const part = event.payload.properties.part
    return `${event.directory}:${part.messageID}:${part.id}`
  }
}

const replaceableKey = (event: QueuedGlobalEvent) => {
  if (event.payload.type === "session.status")
    return `session.status:${event.directory}:${event.payload.properties.sessionID}`
  if (event.payload.type === "lsp.updated") return `lsp.updated:${event.directory}`
}

const appendDelta = (event: QueuedGlobalEvent, delta: string): QueuedGlobalEvent => {
  if (event.payload.type !== "message.part.delta") return event
  return {
    ...event,
    payload: {
      ...event.payload,
      properties: {
        ...event.payload.properties,
        delta: event.payload.properties.delta + delta,
      },
    },
  }
}

export function coalesceQueuedEvents(events: QueuedGlobalEvent[]): QueuedGlobalEvent[] {
  const result: (QueuedGlobalEvent | undefined)[] = []
  const replaceable = new Map<string, number>()
  const deltaIndexesByPart = new Map<string, Set<number>>()
  const pushEvent = (event: QueuedGlobalEvent) => {
    const index = result.length
    result.push(event)

    const key = partKey(event)
    if (event.payload.type === "message.part.delta" && key) {
      const indexes = deltaIndexesByPart.get(key) ?? new Set<number>()
      indexes.add(index)
      deltaIndexesByPart.set(key, indexes)
    }

    return index
  }

  for (const event of events) {
    const replaceKey = replaceableKey(event)
    if (replaceKey) {
      const index = replaceable.get(replaceKey)
      if (index !== undefined) {
        result[index] = event
        continue
      }
      replaceable.set(replaceKey, pushEvent(event))
      continue
    }

    if (event.payload.type === "message.part.updated") {
      const updatedKey = partKey(event)
      if (updatedKey) {
        for (const index of deltaIndexesByPart.get(updatedKey) ?? []) {
          result[index] = undefined
        }
        deltaIndexesByPart.delete(updatedKey)
      }
      pushEvent(event)
      continue
    }

    if (event.payload.type === "message.part.delta") {
      const last = result[result.length - 1]
      if (last?.payload.type === "message.part.delta" && deltaKey(last) === deltaKey(event)) {
        result[result.length - 1] = appendDelta(last, event.payload.properties.delta)
        continue
      }
    }

    pushEvent(event)
  }

  return result.filter((event): event is QueuedGlobalEvent => event !== undefined)
}
