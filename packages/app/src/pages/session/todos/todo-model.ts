import type { Todo } from "@opencode-ai/sdk/v2/client"

export type TodoPhase = "empty" | "active" | "terminal"

export type TodoSourceKind = "primary-backend" | "primary-parts" | "fallback-backend" | "fallback-parts" | "none"

export type SessionTodoItem = Pick<Todo, "content" | "priority" | "status"> & Partial<Pick<Todo, "id">>

export type TodoSnapshot = {
  sessionID?: string
  source: TodoSourceKind
  items: SessionTodoItem[]
  phase: TodoPhase
  sourceUpdatedAt?: number
}

export function isTerminalTodo(todo: Pick<Todo, "status">): boolean {
  return todo.status === "completed" || todo.status === "cancelled"
}

export function todoPhase(todos: readonly Pick<Todo, "status">[]): TodoPhase {
  if (todos.length === 0) return "empty"
  return todos.every(isTerminalTodo) ? "terminal" : "active"
}

export function todoSnapshot(input: {
  sessionID?: string
  source: TodoSourceKind
  items: SessionTodoItem[]
  sourceUpdatedAt?: number
}): TodoSnapshot {
  const phase = todoPhase(input.items)
  return {
    sessionID: input.sessionID,
    source: input.source,
    items: input.items,
    phase,
    sourceUpdatedAt: input.sourceUpdatedAt,
  }
}
