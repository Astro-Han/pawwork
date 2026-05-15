import { describe, expect, test } from "bun:test"
import type { Part, ToolState } from "@opencode-ai/sdk/v2"
import type { Todo } from "@opencode-ai/sdk/v2/client"
import { selectSessionTodos } from "./session-todos"
import type { SessionTodoItem } from "./todos/todo-model"

const completedState = (
  overrides: Partial<Extract<ToolState, { status: "completed" }>> = {},
): Extract<ToolState, { status: "completed" }> => ({
  status: "completed",
  input: {},
  output: "",
  title: "",
  metadata: {},
  time: { start: 0, end: 0 },
  ...overrides,
})

const toolPart = (tool: string, state: ToolState = completedState()): Part =>
  ({
    id: "p",
    sessionID: "s",
    messageID: "m",
    type: "tool",
    callID: "c",
    tool,
    state,
  }) as Part

const todo = (content: string, status: SessionTodoItem["status"] = "pending"): SessionTodoItem => ({
  content,
  status,
  priority: "medium",
})

const backendTodo = (content: string, status: Todo["status"] = "pending"): Todo => ({
  id: `todo_${content}`,
  content,
  status,
  priority: "medium",
})

describe("selectSessionTodos", () => {
  test("prefers message-derived todos over lagging backend todos", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("from parts", "in_progress")] } }))]

    expect(selectSessionTodos({ backend: [backendTodo("from backend", "pending")], parts })).toEqual([
      todo("from parts", "in_progress"),
    ])
  })

  test("uses backend terminal todos when matching message-derived todos are stale active", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("task A", "in_progress")] } }))]

    expect(selectSessionTodos({ backend: [backendTodo("task A", "completed")], parts })).toEqual([
      backendTodo("task A", "completed"),
    ])
  })

  test("keeps message-derived active todos when terminal backend todos do not match", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("new task", "in_progress")] } }))]

    expect(selectSessionTodos({ backend: [backendTodo("old task", "completed")], parts })).toEqual([
      todo("new task", "in_progress"),
    ])
  })

  test("returns completed-only historical parts for status summary display", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("done from parts", "completed")] } }))]

    expect(selectSessionTodos({ backend: [], parts })).toEqual([todo("done from parts", "completed")])
  })

  test("falls back to latest todowrite parts when backend todos are unknown", () => {
    const parts = [
      toolPart("todowrite", completedState({ input: { todos: [todo("old", "pending")] } })),
      toolPart("todowrite", completedState({ input: { todos: [todo("new", "in_progress")] } })),
    ]

    expect(selectSessionTodos({ backend: undefined, parts })).toEqual([todo("new", "in_progress")])
  })

  test("returns empty when known backend todos clear stale active parts", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("old", "in_progress")] } }))]

    expect(selectSessionTodos({ backend: [], backendClearActiveParts: true, parts })).toEqual([])
  })

  test("keeps active parts over ordinary empty backend cache", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("new", "in_progress")] } }))]

    expect(selectSessionTodos({ backend: [], parts })).toEqual([todo("new", "in_progress")])
  })

  test("falls back to a secondary session source when the primary source is empty", () => {
    const fallbackParts = [
      toolPart("todowrite", completedState({ input: { todos: [todo("route todo", "in_progress")] } })),
    ]

    expect(selectSessionTodos({ backend: [], parts: [], fallback: { parts: fallbackParts } })).toEqual([
      todo("route todo", "in_progress"),
    ])
  })
})
