import type { Part, Todo } from "@opencode-ai/sdk/v2"
import { extractTodos } from "@/pages/session/session-status-extractors"
import { todoSnapshot, type SessionTodoItem, type TodoSnapshot, type TodoSourceKind } from "./todo-model"

export type CanonicalTodoSnapshot = {
  revision: number
  todos: Todo[]
}

export type SessionTodoSource = {
  sessionID?: string
  canonical?: CanonicalTodoSnapshot
  isAuthoritativelyInvalidated?: boolean
  isPending?: boolean
  parts: Part[]
}

export type SelectSessionTodosInput = {
  primary: SessionTodoSource
  fallback?: SessionTodoSource
}

const partTodos = (parts: Part[]) => extractTodos(parts)

const sourceTodoSnapshot = (
  input: SessionTodoSource,
  source: { backend: TodoSourceKind; parts: TodoSourceKind },
): TodoSnapshot | undefined => {
  if (input.isAuthoritativelyInvalidated) {
    return todoSnapshot({
      sessionID: input.sessionID,
      source: "invalidated",
      items: [],
    })
  }

  if (input.canonical !== undefined) {
    return todoSnapshot({
      sessionID: input.sessionID,
      source: source.backend,
      items: input.canonical.todos,
    })
  }

  if (input.isPending) {
    return todoSnapshot({
      sessionID: input.sessionID,
      source: "pending",
      items: [],
      phase: "pending",
    })
  }

  const sourceParts = partTodos(input.parts)
  if (sourceParts.length > 0) {
    return todoSnapshot({
      sessionID: input.sessionID,
      source: source.parts,
      items: sourceParts,
    })
  }
}

// Data snapshots are for status displays. Transcript parts are render-only
// placeholders until the canonical backend snapshot is present.
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
