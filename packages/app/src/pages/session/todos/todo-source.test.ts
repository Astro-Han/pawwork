import { describe, expect, test } from "bun:test"
import type { Part, ToolState } from "@opencode-ai/sdk/v2"
import type { Todo } from "@opencode-ai/sdk/v2/client"
import { selectSessionTodoDataSnapshot, selectSessionTodoDockSnapshot, selectSessionTodos } from "./todo-source"

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
  test("returns completed-only parts for status summary display", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("done from parts", "completed")] } }))]

    expect(selectSessionTodoDataSnapshot({ primary: { backend: [], parts } })).toMatchObject({
      source: "primary-parts",
      items: [todo("done from parts", "completed")],
      phase: "terminal",
      dockEligible: false,
      historicalTerminal: true,
    })
  })

  test("uses matching backend terminal todos over stale active parts", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("task A", "in_progress")] } }))]

    expect(
      selectSessionTodoDataSnapshot({
        primary: { backend: [todo("task A", "completed")], parts },
      }),
    ).toMatchObject({
      source: "primary-backend",
      items: [todo("task A", "completed")],
      phase: "terminal",
      dockEligible: false,
      historicalTerminal: true,
    })
  })
})

describe("selectSessionTodoDockSnapshot", () => {
  test("prefers active primary message-derived todos over lagging backend todos", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("from parts", "in_progress")] } }))]

    expect(
      selectSessionTodoDockSnapshot({ primary: { backend: [todo("from backend", "pending")], parts } }),
    ).toMatchObject({
      source: "primary-parts",
      items: [todo("from parts", "in_progress")],
      phase: "active",
      dockEligible: true,
    })
  })

  test("prefers terminal primary parts over lagging backend todos", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("done from parts", "completed")] } }))]

    expect(
      selectSessionTodoDockSnapshot({ primary: { backend: [todo("from backend", "pending")], parts } }),
    ).toMatchObject({
      source: "primary-parts",
      items: [todo("done from parts", "completed")],
      phase: "terminal",
    })
  })

  test("backend terminal updates override stale active parts", () => {
    // Scenario: LLM called todowrite once marking task as in_progress.
    // Later, backend received a todo.updated event marking it completed.
    // Backend terminal state should take precedence over stale active parts.
    const parts = [
      toolPart("todowrite", completedState({ input: { todos: [todo("task A", "in_progress")] } })),
    ]

    expect(
      selectSessionTodoDockSnapshot({
        primary: { backend: [todo("task A", "completed")], parts },
      }),
    ).toMatchObject({
      source: "primary-backend",
      items: [todo("task A", "completed")],
      phase: "terminal",
      dockEligible: false,
      historicalTerminal: true,
    })
  })

  test("keeps active parts when terminal backend describes a different todo", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("new task", "in_progress")] } }))]

    expect(
      selectSessionTodoDockSnapshot({
        primary: { backend: [todo("old task", "completed")], parts },
      }),
    ).toMatchObject({
      source: "primary-parts",
      items: [todo("new task", "in_progress")],
      phase: "active",
      dockEligible: true,
    })
  })

  test("does not reopen completed-only historical parts over an empty backend", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("done from parts", "completed")] } }))]

    expect(selectSessionTodoDockSnapshot({ primary: { backend: [], parts } })).toMatchObject({
      source: "primary-parts",
      items: [todo("done from parts", "completed")],
      phase: "terminal",
      dockEligible: false,
      historicalTerminal: true,
    })
  })

  test("uses active fallback parts when primary sources are empty", () => {
    const fallbackParts = [
      toolPart("todowrite", completedState({ input: { todos: [todo("route todo", "in_progress")] } })),
    ]

    expect(
      selectSessionTodoDockSnapshot({
        primary: { backend: [], parts: [] },
        fallback: { backend: [], parts: fallbackParts },
      }),
    ).toMatchObject({ source: "fallback-parts", items: [todo("route todo", "in_progress")] })
  })

  test("uses fallback backend when no active fallback parts exist", () => {
    expect(
      selectSessionTodoDockSnapshot({
        primary: { backend: [], parts: [] },
        fallback: { backend: [todo("fallback backend", "pending")], parts: [] },
      }),
    ).toMatchObject({ source: "fallback-backend", items: [todo("fallback backend", "pending")] })
  })

  test("uses matching fallback backend terminal todos over stale fallback active parts", () => {
    const fallbackParts = [
      toolPart("todowrite", completedState({ input: { todos: [todo("fallback task", "in_progress")] } })),
    ]

    expect(
      selectSessionTodoDockSnapshot({
        primary: { backend: [], parts: [] },
        fallback: { backend: [todo("fallback task", "completed")], parts: fallbackParts },
      }),
    ).toMatchObject({
      source: "fallback-backend",
      items: [todo("fallback task", "completed")],
      phase: "terminal",
      dockEligible: false,
      historicalTerminal: true,
    })
  })

  test("keeps primary terminal backend ahead of fallback active parts", () => {
    const fallbackParts = [
      toolPart("todowrite", completedState({ input: { todos: [todo("fallback active", "in_progress")] } })),
    ]

    expect(
      selectSessionTodoDockSnapshot({
        primary: { backend: [todo("primary done", "completed")], parts: [] },
        fallback: { backend: [], parts: fallbackParts },
      }),
    ).toMatchObject({ source: "primary-backend", items: [todo("primary done", "completed")], phase: "terminal" })
  })
})

describe("selectSessionTodos", () => {
  test("keeps the existing items-only wrapper", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("from parts", "in_progress")] } }))]

    expect(selectSessionTodos({ backend: [todo("from backend", "pending")], parts })).toEqual([
      todo("from parts", "in_progress"),
    ])
  })

  test("returns backend terminal todos when matching parts are stale active", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("task A", "in_progress")] } }))]

    expect(selectSessionTodos({ backend: [todo("task A", "completed")], parts })).toEqual([
      todo("task A", "completed"),
    ])
  })

  test("returns fallback backend terminal todos when matching fallback parts are stale active", () => {
    const fallbackParts = [
      toolPart("todowrite", completedState({ input: { todos: [todo("fallback task", "in_progress")] } })),
    ]

    expect(
      selectSessionTodos({
        backend: [],
        parts: [],
        fallback: { backend: [todo("fallback task", "completed")], parts: fallbackParts },
      }),
    ).toEqual([todo("fallback task", "completed")])
  })
})
