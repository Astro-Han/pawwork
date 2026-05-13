import type { Event } from "@opencode-ai/sdk/v2/client"

export type QueuedGlobalEvent = { directory: string; payload: Event }

const deltaKey = (event: QueuedGlobalEvent) => {
  if (event.payload.type !== "message.part.delta") return
  const props = event.payload.properties
  return JSON.stringify([event.directory, props.messageID, props.partID, props.field])
}

const partKey = (event: QueuedGlobalEvent) => {
  if (event.payload.type === "message.part.delta") {
    const props = event.payload.properties
    return JSON.stringify([event.directory, props.messageID, props.partID])
  }
  if (event.payload.type === "message.part.updated") {
    const part = event.payload.properties.part
    return JSON.stringify([event.directory, part.messageID, part.id])
  }
}

const replaceableKey = (event: QueuedGlobalEvent) => {
  if (event.payload.type === "session.status")
    return JSON.stringify(["session.status", event.directory, event.payload.properties.sessionID])
  if (event.payload.type === "lsp.updated") return JSON.stringify(["lsp.updated", event.directory])
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
  const mergeableDeltaIndexByKey = new Map<string, number>()
  const pushEvent = (event: QueuedGlobalEvent) => {
    const index = result.length
    result.push(event)

    const part = partKey(event)
    if (event.payload.type === "message.part.delta" && part) {
      const indexes = deltaIndexesByPart.get(part) ?? new Set<number>()
      indexes.add(index)
      deltaIndexesByPart.set(part, indexes)
    }

    return index
  }

  const resetMergeableDeltaIndexes = () => {
    mergeableDeltaIndexByKey.clear()
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
      resetMergeableDeltaIndexes()
      pushEvent(event)
      continue
    }

    if (event.payload.type === "message.part.delta") {
      const key = deltaKey(event)
      const index = key ? mergeableDeltaIndexByKey.get(key) : undefined
      const target = index !== undefined ? result[index] : undefined
      if (key && index !== undefined && target?.payload.type === "message.part.delta") {
        result[index] = appendDelta(target, event.payload.properties.delta)
        continue
      }

      resetMergeableDeltaIndexes()
      const nextIndex = pushEvent(event)
      if (key) mergeableDeltaIndexByKey.set(key, nextIndex)
      continue
    }

    resetMergeableDeltaIndexes()
    pushEvent(event)
  }

  return result.filter((event): event is QueuedGlobalEvent => event !== undefined)
}
