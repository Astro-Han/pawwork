import { describe, expect, test } from "bun:test"
import type { Part, ToolState } from "@opencode-ai/sdk/v2"
import type { Todo } from "@opencode-ai/sdk/v2/client"
import { selectSessionTodoDataSnapshot, selectSessionTodos } from "./todo-source"

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

describe("selectSessionTodoDataSnapshot", () => {
  test("returns only status summary fields", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("status only", "in_progress")] } }))]

    expect(Object.keys(selectSessionTodoDataSnapshot({ primary: { backend: undefined, parts } })).sort()).toEqual(
      ["items", "phase", "sessionID", "source"].sort(),
    )
  })

  test("uses transcript parts only while backend snapshot is absent", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("from parts", "in_progress")] } }))]

    expect(selectSessionTodoDataSnapshot({ primary: { backend: undefined, parts } })).toMatchObject({
      source: "primary-parts",
      items: [todo("from parts", "in_progress")],
      phase: "active",
    })
  })

  test("uses backend todos over render-only parts placeholders", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("from parts", "in_progress")] } }))]

    expect(
      selectSessionTodoDataSnapshot({ primary: { backend: [todo("from backend", "pending")], parts } }),
    ).toMatchObject({
      source: "primary-backend",
      items: [todo("from backend", "pending")],
      phase: "active",
    })
  })

  test("uses terminal backend even when parts describe a different active todo", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("new task", "in_progress")] } }))]

    expect(
      selectSessionTodoDataSnapshot({
        primary: { backend: [todo("old task", "completed")], parts },
      }),
    ).toMatchObject({
      source: "primary-backend",
      items: [todo("old task", "completed")],
      phase: "terminal",
    })
  })

  test("uses known empty backend over active parts placeholders", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("cleared task", "in_progress")] } }))]

    expect(selectSessionTodoDataSnapshot({ primary: { backend: [], parts } })).toMatchObject({
      source: "primary-backend",
      items: [],
      phase: "empty",
    })
  })

  test("does not use part timestamps to override an empty backend snapshot", () => {
    const parts = [
      toolPart(
        "todowrite",
        completedState({ input: { todos: [todo("new task", "in_progress")] }, time: { start: 2, end: 2 } }),
      ),
    ]

    expect(selectSessionTodoDataSnapshot({ primary: { backend: [], parts } })).toMatchObject({
      source: "primary-backend",
      items: [],
      phase: "empty",
    })
  })

  test("falls back to active fallback parts when primary sources are empty", () => {
    const fallbackParts = [
      toolPart("todowrite", completedState({ input: { todos: [todo("route todo", "in_progress")] } })),
    ]

    expect(
      selectSessionTodoDataSnapshot({
        primary: { backend: [], parts: [] },
        fallback: { parts: fallbackParts },
      }),
    ).toMatchObject({ source: "fallback-parts", items: [todo("route todo", "in_progress")] })
  })

  test("uses known empty fallback backend over fallback active parts placeholders", () => {
    const fallbackParts = [
      toolPart("todowrite", completedState({ input: { todos: [todo("fallback cleared", "in_progress")] } })),
    ]

    expect(
      selectSessionTodoDataSnapshot({
        primary: { backend: [], parts: [] },
        fallback: { backend: [], parts: fallbackParts },
      }),
    ).toMatchObject({
      source: "fallback-backend",
      items: [],
      phase: "empty",
    })
  })
})

describe("selectSessionTodos", () => {
  test("keeps the existing items-only wrapper", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("from parts", "in_progress")] } }))]

    expect(selectSessionTodos({ backend: undefined, parts })).toEqual([todo("from parts", "in_progress")])
  })

  test("returns backend terminal todos when parts are stale active placeholders", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("task A", "in_progress")] } }))]

    expect(selectSessionTodos({ backend: [todo("task A", "completed")], parts })).toEqual([
      todo("task A", "completed"),
    ])
  })

  test("returns empty todos when backend snapshot is empty", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("cleared task", "in_progress")] } }))]

    expect(selectSessionTodos({ backend: [], parts })).toEqual([])
  })
})
