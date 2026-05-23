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

    expect(selectSessionTodoDataSnapshot({ primary: { backend: undefined, parts } })).toMatchObject({
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
  test("uses primary backend todos over render-only parts placeholders", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("from parts", "in_progress")] } }))]

    expect(
      selectSessionTodoDockSnapshot({ primary: { backend: [todo("from backend", "pending")], parts } }),
    ).toMatchObject({
      source: "primary-backend",
      items: [todo("from backend", "pending")],
      phase: "active",
      dockEligible: true,
    })
  })

  test("keeps primary backend ahead of terminal parts placeholders", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("done from parts", "completed")] } }))]

    expect(
      selectSessionTodoDockSnapshot({ primary: { backend: [todo("from backend", "pending")], parts } }),
    ).toMatchObject({
      source: "primary-backend",
      items: [todo("from backend", "pending")],
      phase: "active",
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

  test("uses terminal backend even when parts describe a different active todo", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("new task", "in_progress")] } }))]

    expect(
      selectSessionTodoDockSnapshot({
        primary: { backend: [todo("old task", "completed")], parts },
      }),
    ).toMatchObject({
      source: "primary-backend",
      items: [todo("old task", "completed")],
      phase: "terminal",
      dockEligible: false,
    })
  })

  test("uses known empty backend over active parts placeholders", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("cleared task", "in_progress")] } }))]

    expect(
      selectSessionTodoDockSnapshot({
        primary: { backend: [], parts },
      }),
    ).toMatchObject({
      source: "primary-backend",
      items: [],
      phase: "empty",
      dockEligible: false,
    })
  })

  test("does not compare part timestamps against an empty backend snapshot", () => {
    const parts = [
      toolPart(
        "todowrite",
        completedState({ input: { todos: [todo("new task", "in_progress")] }, time: { start: 2, end: 2 } }),
      ),
    ]

    expect(
      selectSessionTodoDockSnapshot({
        primary: { backend: [], parts },
      }),
    ).toMatchObject({
      source: "primary-backend",
      items: [],
      phase: "empty",
      dockEligible: false,
    })
  })

  test("uses ordinary empty backend cache over active parts placeholders", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("new task", "in_progress")] } }))]

    expect(
      selectSessionTodoDockSnapshot({
        primary: { backend: [], parts },
      }),
    ).toMatchObject({
      source: "primary-backend",
      items: [],
      phase: "empty",
      dockEligible: false,
    })
  })

  test("does not reopen completed-only historical parts over an empty backend", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("done from parts", "completed")] } }))]

    expect(selectSessionTodoDockSnapshot({ primary: { backend: [], parts } })).toMatchObject({
      source: "primary-backend",
      items: [],
      phase: "empty",
      dockEligible: false,
    })
  })

  test("uses active fallback parts when primary sources are empty", () => {
    const fallbackParts = [
      toolPart("todowrite", completedState({ input: { todos: [todo("route todo", "in_progress")] } })),
    ]

    expect(
      selectSessionTodoDockSnapshot({
        primary: { backend: [], parts: [] },
        fallback: { parts: fallbackParts },
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

  test("uses known empty fallback backend over fallback active parts placeholders", () => {
    const fallbackParts = [
      toolPart("todowrite", completedState({ input: { todos: [todo("fallback cleared", "in_progress")] } })),
    ]

    expect(
      selectSessionTodoDockSnapshot({
        primary: { backend: [], parts: [] },
        fallback: { backend: [], parts: fallbackParts },
      }),
    ).toMatchObject({
      source: "fallback-backend",
      items: [],
      phase: "empty",
      dockEligible: false,
    })
  })

  test("uses ordinary empty fallback backend over fallback active parts placeholders", () => {
    const fallbackParts = [
      toolPart("todowrite", completedState({ input: { todos: [todo("fallback active", "in_progress")] } })),
    ]

    expect(
      selectSessionTodoDockSnapshot({
        primary: { backend: [], parts: [] },
        fallback: { backend: [], parts: fallbackParts },
      }),
    ).toMatchObject({
      source: "fallback-backend",
      items: [],
      phase: "empty",
      dockEligible: false,
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

    expect(selectSessionTodos({ backend: undefined, parts })).toEqual([
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

  test("returns empty todos when backend snapshot is empty", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("cleared task", "in_progress")] } }))]

    expect(selectSessionTodos({ backend: [], parts })).toEqual([])
  })

  test("does not use part timestamps to override an empty backend snapshot", () => {
    const parts = [
      toolPart(
        "todowrite",
        completedState({ input: { todos: [todo("new task", "in_progress")] }, time: { start: 2, end: 2 } }),
      ),
    ]

    expect(selectSessionTodos({ backend: [], parts })).toEqual([])
  })

  test("returns empty todos when ordinary backend cache is empty", () => {
    const parts = [toolPart("todowrite", completedState({ input: { todos: [todo("new task", "in_progress")] } }))]

    expect(selectSessionTodos({ backend: [], parts })).toEqual([])
  })
})
