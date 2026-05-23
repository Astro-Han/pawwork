import type { Part, Todo } from "@opencode-ai/sdk/v2"
import { extractTodos, TOOL_TODOWRITE } from "@/pages/session/session-status-extractors"
import { todoPhase, todoSnapshot, type SessionTodoItem, type TodoSnapshot, type TodoSourceKind } from "./todo-model"

export type SessionTodoSource = {
  sessionID?: string
  backend?: Todo[]
  backendClearActivePartsAt?: number
  parts: Part[]
}

export type SelectSessionTodosInput = {
  primary: SessionTodoSource
  fallback?: SessionTodoSource
}

const partTodos = (parts: Part[]) => extractTodos(parts)

const latestTodoWriteTime = (parts: Part[]) => {
  let latest: number | undefined
  for (const part of parts) {
    if (part.type !== "tool") continue
    if (part.tool !== TOOL_TODOWRITE) continue
    if (part.state.status !== "completed") continue
    const time = part.state.time
    const value = typeof time.end === "number" ? time.end : typeof time.start === "number" ? time.start : undefined
    if (value === undefined) continue
    latest = latest === undefined ? value : Math.max(latest, value)
  }
  return latest
}

const sameTodoList = (backend: SessionTodoItem[], parts: SessionTodoItem[]) => {
  if (backend.length !== parts.length) return false
  return parts.every((part, index) => {
    const fromBackend = backend[index]
    if (!fromBackend) return false
    if (part.id && fromBackend.id) return part.id === fromBackend.id
    return part.content === fromBackend.content
  })
}

const sourceTodoSnapshot = (
  input: SessionTodoSource,
  source: { backend: TodoSourceKind; parts: TodoSourceKind },
): TodoSnapshot | undefined => {
  const sourceParts = partTodos(input.parts)
  const sourceBackend = input.backend ?? []

  if (sourceParts.length > 0 && sourceBackend.length > 0) {
    const partsPhase = todoPhase(sourceParts)
    const backendPhase = todoPhase(sourceBackend)
    if (backendPhase === "terminal" && partsPhase === "active" && sameTodoList(sourceBackend, sourceParts)) {
      return todoSnapshot({
        sessionID: input.sessionID,
        source: source.backend,
        items: sourceBackend,
      })
    }
  }

  if (sourceParts.length > 0) {
    const phase = todoPhase(sourceParts)
    if (input.backendClearActivePartsAt !== undefined && sourceBackend.length === 0 && phase === "active") {
      const partsTime = latestTodoWriteTime(input.parts)
      if (partsTime === undefined || partsTime <= input.backendClearActivePartsAt) {
        return todoSnapshot({ sessionID: input.sessionID, source: source.backend, items: [] })
      }
    }
    return todoSnapshot({
      sessionID: input.sessionID,
      source: source.parts,
      items: sourceParts,
      sourceUpdatedAt: latestTodoWriteTime(input.parts),
    })
  }

  if (sourceBackend.length > 0) {
    return todoSnapshot({ sessionID: input.sessionID, source: source.backend, items: sourceBackend })
  }
}

// Data snapshots are for status displays and should preserve the latest todo
// list even when it is terminal.
export function selectSessionTodoDataSnapshot(input: SelectSessionTodosInput): TodoSnapshot {
  const primary = sourceTodoSnapshot(input.primary, { backend: "primary-backend", parts: "primary-parts" })
  if (primary) return primary

  const fallback = input.fallback
    ? sourceTodoSnapshot(input.fallback, { backend: "fallback-backend", parts: "fallback-parts" })
    : undefined
  if (fallback) return fallback

  return todoSnapshot({ sessionID: input.primary.sessionID, source: "none", items: [] })
}

export function selectSessionTodos(input: SessionTodoSource & { fallback?: SessionTodoSource }): SessionTodoItem[] {
  return selectSessionTodoDataSnapshot({ primary: input, fallback: input.fallback }).items
}
