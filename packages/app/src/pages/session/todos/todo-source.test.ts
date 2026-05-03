import { describe, expect, test } from "bun:test"
import type { Part, ToolState } from "@opencode-ai/sdk/v2"
import type { Todo } from "@opencode-ai/sdk/v2/client"
import { selectSessionTodoSnapshot, selectSessionTodos } from "./todo-source"

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
})

describe("selectSessionTodoSnapshot", () => {
  test("prefers active primary message-derived todos over lagging backend todos", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("from parts", "in_progress")] } }))]

    expect(selectSessionTodoSnapshot({ primary: { backend: [todo("from backend", "pending")], parts } })).toMatchObject(
      {
        source: "primary-parts",
        items: [todo("from parts", "in_progress")],
        phase: "active",
      },
    )
  })

  test("prefers backend over completed-only primary parts", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("done from parts", "completed")] } }))]

    expect(selectSessionTodoSnapshot({ primary: { backend: [todo("from backend", "pending")], parts } })).toMatchObject(
      {
        source: "primary-backend",
        items: [todo("from backend", "pending")],
      },
    )
  })

  test("does not reopen completed-only historical parts over an empty backend", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("done from parts", "completed")] } }))]

    expect(selectSessionTodoSnapshot({ primary: { backend: [], parts } })).toMatchObject({
      source: "none",
      items: [],
      phase: "empty",
    })
  })

  test("uses active fallback parts when primary sources are empty", () => {
    const fallbackParts = [
      toolPart("todowrite", completedState({ input: { todos: [todo("route todo", "in_progress")] } })),
    ]

    expect(
      selectSessionTodoSnapshot({
        primary: { backend: [], parts: [] },
        fallback: { backend: [], parts: fallbackParts },
      }),
    ).toMatchObject({ source: "fallback-parts", items: [todo("route todo", "in_progress")] })
  })

  test("uses fallback backend when no active fallback parts exist", () => {
    expect(
      selectSessionTodoSnapshot({
        primary: { backend: [], parts: [] },
        fallback: { backend: [todo("fallback backend", "pending")], parts: [] },
      }),
    ).toMatchObject({ source: "fallback-backend", items: [todo("fallback backend", "pending")] })
  })
})

describe("selectSessionTodos", () => {
  test("keeps the existing items-only wrapper", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("from parts", "in_progress")] } }))]

    expect(selectSessionTodos({ backend: [todo("from backend", "pending")], parts })).toEqual([
      todo("from parts", "in_progress"),
    ])
  })
})
