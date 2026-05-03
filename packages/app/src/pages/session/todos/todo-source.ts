import type { Part, Todo } from "@opencode-ai/sdk/v2"
import { extractTodos } from "@/pages/session/session-status-extractors"
import { todoPhase, todoSnapshot, type TodoSnapshot } from "./todo-model"

export type SessionTodoSource = {
  sessionID?: string
  backend?: Todo[]
  parts: Part[]
}

export type SelectSessionTodosInput = {
  primary: SessionTodoSource
  fallback?: SessionTodoSource
}

const partTodos = (parts: Part[]) => extractTodos(parts) as Todo[]

export function selectSessionTodoSnapshot(input: SelectSessionTodosInput): TodoSnapshot {
  const primaryParts = partTodos(input.primary.parts)
  if (todoPhase(primaryParts) === "active") {
    return todoSnapshot({ sessionID: input.primary.sessionID, source: "primary-parts", items: primaryParts })
  }

  if (input.primary.backend && input.primary.backend.length > 0) {
    return todoSnapshot({ sessionID: input.primary.sessionID, source: "primary-backend", items: input.primary.backend })
  }

  const fallbackParts = partTodos(input.fallback?.parts ?? [])
  if (todoPhase(fallbackParts) === "active") {
    return todoSnapshot({ sessionID: input.fallback?.sessionID, source: "fallback-parts", items: fallbackParts })
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

export function selectSessionTodos(input: SessionTodoSource & { fallback?: SessionTodoSource }): Todo[] {
  return selectSessionTodoSnapshot({ primary: input, fallback: input.fallback }).items
}
