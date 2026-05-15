import type { Part, Todo } from "@opencode-ai/sdk/v2"
import { extractTodos } from "@/pages/session/session-status-extractors"
import { todoPhase, todoSnapshot, type SessionTodoItem, type TodoSnapshot, type TodoSourceKind } from "./todo-model"

export type SessionTodoSource = {
  sessionID?: string
  backend?: Todo[]
  backendClearActiveParts?: boolean
  parts: Part[]
}

export type SelectSessionTodosInput = {
  primary: SessionTodoSource
  fallback?: SessionTodoSource
}

const partTodos = (parts: Part[]) => extractTodos(parts)

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
        dockEligible: false,
        historicalTerminal: true,
      })
    }
  }

  if (sourceParts.length > 0) {
    const phase = todoPhase(sourceParts)
    if (input.backendClearActiveParts === true && sourceBackend.length === 0 && phase === "active") {
      return todoSnapshot({ sessionID: input.sessionID, source: source.backend, items: [], dockEligible: false })
    }
    return todoSnapshot({
      sessionID: input.sessionID,
      source: source.parts,
      items: sourceParts,
      dockEligible: phase === "active",
      historicalTerminal: phase === "terminal",
    })
  }

  if (sourceBackend.length > 0) {
    return todoSnapshot({ sessionID: input.sessionID, source: source.backend, items: sourceBackend })
  }
}

// Data snapshots are for status displays and should preserve the latest todo
// list even when it is terminal. Dock snapshots below apply the stricter UI
// policy that historical terminal tool parts must not reopen the composer dock.
export function selectSessionTodoDataSnapshot(input: SelectSessionTodosInput): TodoSnapshot {
  const primary = sourceTodoSnapshot(input.primary, { backend: "primary-backend", parts: "primary-parts" })
  if (primary) return primary

  const fallback = input.fallback
    ? sourceTodoSnapshot(input.fallback, { backend: "fallback-backend", parts: "fallback-parts" })
    : undefined
  if (fallback) return fallback

  return todoSnapshot({ sessionID: input.primary.sessionID, source: "none", items: [] })
}

export function selectSessionTodoDockSnapshot(input: SelectSessionTodosInput): TodoSnapshot {
  // Dock source precedence is intentionally stricter than data precedence:
  // tool parts can beat lagging backend state while the dock machine decides
  // whether terminal snapshots complete an active dock or stay hidden history.
  const primary = sourceTodoSnapshot(input.primary, { backend: "primary-backend", parts: "primary-parts" })
  if (primary) return primary

  const fallback = input.fallback
    ? sourceTodoSnapshot(input.fallback, { backend: "fallback-backend", parts: "fallback-parts" })
    : undefined
  if (fallback) return fallback

  return todoSnapshot({ sessionID: input.primary.sessionID, source: "none", items: [], dockEligible: false })
}

export function selectSessionTodos(input: SessionTodoSource & { fallback?: SessionTodoSource }): SessionTodoItem[] {
  return selectSessionTodoDataSnapshot({ primary: input, fallback: input.fallback }).items
}
