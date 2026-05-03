import type { Part, Todo } from "@opencode-ai/sdk/v2"
import { extractTodos } from "@/pages/session/session-status-extractors"
import { todoPhase, todoSnapshot, type SessionTodoItem, type TodoSnapshot } from "./todo-model"

export type SessionTodoSource = {
  sessionID?: string
  backend?: Todo[]
  parts: Part[]
}

export type SelectSessionTodosInput = {
  primary: SessionTodoSource
  fallback?: SessionTodoSource
}

const partTodos = (parts: Part[]) => extractTodos(parts)

// Data snapshots are for status displays and should preserve the latest todo
// list even when it is terminal. Dock snapshots below apply the stricter UI
// policy that historical terminal tool parts must not reopen the composer dock.
export function selectSessionTodoDataSnapshot(input: SelectSessionTodosInput): TodoSnapshot {
  const primaryParts = partTodos(input.primary.parts)
  if (primaryParts.length > 0) {
    const phase = todoPhase(primaryParts)
    return todoSnapshot({
      sessionID: input.primary.sessionID,
      source: "primary-parts",
      items: primaryParts,
      dockEligible: phase === "active",
      historicalTerminal: phase === "terminal",
    })
  }

  if (input.primary.backend && input.primary.backend.length > 0) {
    return todoSnapshot({ sessionID: input.primary.sessionID, source: "primary-backend", items: input.primary.backend })
  }

  const fallbackParts = partTodos(input.fallback?.parts ?? [])
  if (fallbackParts.length > 0) {
    const phase = todoPhase(fallbackParts)
    return todoSnapshot({
      sessionID: input.fallback?.sessionID,
      source: "fallback-parts",
      items: fallbackParts,
      dockEligible: phase === "active",
      historicalTerminal: phase === "terminal",
    })
  }

  if (input.fallback?.backend && input.fallback.backend.length > 0) {
    return todoSnapshot({
      sessionID: input.fallback.sessionID,
      source: "fallback-backend",
      items: input.fallback.backend,
    })
  }

  return todoSnapshot({ sessionID: input.primary.sessionID, source: "none", items: [] })
}

export function selectSessionTodoDockSnapshot(input: SelectSessionTodosInput): TodoSnapshot {
  // Dock source precedence is intentionally stricter than data precedence:
  // tool parts can beat lagging backend state while the dock machine decides
  // whether terminal snapshots complete an active dock or stay hidden history.
  const primaryParts = partTodos(input.primary.parts)
  if (primaryParts.length > 0) {
    const phase = todoPhase(primaryParts)
    return todoSnapshot({
      sessionID: input.primary.sessionID,
      source: "primary-parts",
      items: primaryParts,
      dockEligible: phase === "active",
      historicalTerminal: phase === "terminal",
    })
  }

  if (input.primary.backend && input.primary.backend.length > 0) {
    return todoSnapshot({ sessionID: input.primary.sessionID, source: "primary-backend", items: input.primary.backend })
  }

  const fallbackParts = partTodos(input.fallback?.parts ?? [])
  if (fallbackParts.length > 0) {
    const phase = todoPhase(fallbackParts)
    return todoSnapshot({
      sessionID: input.fallback?.sessionID,
      source: "fallback-parts",
      items: fallbackParts,
      dockEligible: phase === "active",
      historicalTerminal: phase === "terminal",
    })
  }

  if (input.fallback?.backend && input.fallback.backend.length > 0) {
    return todoSnapshot({
      sessionID: input.fallback.sessionID,
      source: "fallback-backend",
      items: input.fallback.backend,
    })
  }

  return todoSnapshot({ sessionID: input.primary.sessionID, source: "none", items: [], dockEligible: false })
}

export function selectSessionTodos(input: SessionTodoSource & { fallback?: SessionTodoSource }): SessionTodoItem[] {
  return selectSessionTodoDataSnapshot({ primary: input, fallback: input.fallback }).items
}
