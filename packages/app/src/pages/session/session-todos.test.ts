import { describe, expect, test } from "bun:test"
import type { Part, ToolState } from "@opencode-ai/sdk/v2"
import type { Todo } from "@opencode-ai/sdk/v2/client"
import { selectSessionTodos } from "./session-todos"

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

const todo = (content: string, status: Todo["status"] = "pending"): Todo => ({
  content,
  status,
  priority: "medium",
}) as Todo

describe("selectSessionTodos", () => {
  test("prefers message-derived todos over lagging backend todos", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("from parts", "in_progress")] } }))]

    expect(selectSessionTodos({ backend: [todo("from backend", "pending")], parts })).toEqual([
      todo("from parts", "in_progress"),
    ])
  })

  test("returns completed-only historical parts for status summary display", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("done from parts", "completed")] } }))]

    expect(selectSessionTodos({ backend: [], parts })).toEqual([todo("done from parts", "completed")])
  })

  test("falls back to latest todowrite parts when backend todos are empty", () => {
    const parts = [
      toolPart("todowrite", completedState({ input: { todos: [todo("old", "pending")] } })),
      toolPart("todowrite", completedState({ input: { todos: [todo("new", "in_progress")] } })),
    ]

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
