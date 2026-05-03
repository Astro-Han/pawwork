import type { Todo } from "@opencode-ai/sdk/v2/client"

export type TodoPhase = "empty" | "active" | "terminal"

export type TodoSourceKind = "primary-backend" | "primary-parts" | "fallback-backend" | "fallback-parts" | "none"

export type TodoSnapshot = {
  sessionID?: string
  source: TodoSourceKind
  items: Todo[]
  phase: TodoPhase
  lifecycleSignature: string
  displaySignature: string
}

export function isTerminalTodo(todo: Pick<Todo, "status">): boolean {
  return todo.status === "completed" || todo.status === "cancelled"
}

export function todoPhase(todos: readonly Pick<Todo, "status">[]): TodoPhase {
  if (todos.length === 0) return "empty"
  return todos.every(isTerminalTodo) ? "terminal" : "active"
}

export function todoLifecycleSignature(todos: readonly Pick<Todo, "status">[]): string {
  return todos.map((todo) => todo.status).join("\u0000")
}

export function todoDisplaySignature(todos: readonly Pick<Todo, "content" | "priority" | "status">[]): string {
  return todos.map((todo) => `${todo.status}\u0000${todo.priority}\u0000${todo.content}`).join("\u0001")
}

export function todoSnapshot(input: { sessionID?: string; source: TodoSourceKind; items: Todo[] }): TodoSnapshot {
  const phase = todoPhase(input.items)
  return {
    sessionID: input.sessionID,
    source: input.source,
    items: input.items,
    phase,
    lifecycleSignature: todoLifecycleSignature(input.items),
    displaySignature: todoDisplaySignature(input.items),
  }
}
