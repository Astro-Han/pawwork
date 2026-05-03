import type { Todo } from "@opencode-ai/sdk/v2/client"

export type TodoPhase = "empty" | "active" | "terminal"

export type TodoSourceKind = "primary-backend" | "primary-parts" | "fallback-backend" | "fallback-parts" | "none"

export type SessionTodoItem = Pick<Todo, "content" | "priority" | "status"> & Partial<Pick<Todo, "id">>

export type TodoSnapshot = {
  sessionID?: string
  source: TodoSourceKind
  items: SessionTodoItem[]
  phase: TodoPhase
  lifecycleSignature: string
  displaySignature: string
  dockEligible: boolean
  historicalTerminal: boolean
}

export function isTerminalTodo(todo: Pick<Todo, "status">): boolean {
  return todo.status === "completed" || todo.status === "cancelled"
}

export function todoPhase(todos: readonly Pick<Todo, "status">[]): TodoPhase {
  if (todos.length === 0) return "empty"
  return todos.every(isTerminalTodo) ? "terminal" : "active"
}

export function todoLifecycleSignature(todos: readonly Pick<SessionTodoItem, "id" | "status">[]): string {
  const hasStableIDs = todos.every((todo) => typeof todo.id === "string" && todo.id.length > 0)
  if (hasStableIDs) return JSON.stringify(todos.map((todo) => [todo.id, todo.status]))
  return JSON.stringify(todos.map((todo) => [todo.status]))
}

export function todoDisplaySignature(todos: readonly Pick<Todo, "content" | "priority" | "status">[]): string {
  return JSON.stringify(todos.map((todo) => [todo.status, todo.priority, todo.content]))
}

export function todoSnapshot(input: {
  sessionID?: string
  source: TodoSourceKind
  items: SessionTodoItem[]
  dockEligible?: boolean
  historicalTerminal?: boolean
}): TodoSnapshot {
  const phase = todoPhase(input.items)
  return {
    sessionID: input.sessionID,
    source: input.source,
    items: input.items,
    phase,
    lifecycleSignature: todoLifecycleSignature(input.items),
    displaySignature: todoDisplaySignature(input.items),
    dockEligible: input.dockEligible ?? phase === "active",
    historicalTerminal: input.historicalTerminal ?? false,
  }
}
