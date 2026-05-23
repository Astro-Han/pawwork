import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { Part, ToolState } from "@opencode-ai/sdk/v2"
import type { Message, Todo, TodoSnapshot } from "@opencode-ai/sdk/v2/client"

let createSessionTodoModel: typeof import("./use-session-todos").createSessionTodoModel
let isTodoSnapshotKnownForRestore: typeof import("./use-session-todos").isTodoSnapshotKnownForRestore
let syncData: {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
  todo: Record<string, Todo[] | undefined>
}
let globalSyncData: {
  session_todo: Record<string, TodoSnapshot | undefined>
  session_todo_clear: Record<string, number | undefined>
}

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

const todo = (content: string, status: Todo["status"] = "pending"): Todo =>
  ({
    content,
    status,
    priority: "medium",
  }) as Todo

const todoWritePart = (state: ToolState): Part =>
  ({
    id: "p1",
    sessionID: "s",
    messageID: "m1",
    type: "tool",
    callID: "c1",
    tool: "todowrite",
    state,
  }) as Part

beforeAll(async () => {
  mock.module("@/context/sync", () => ({
    useSync: () => ({ data: syncData }),
  }))
  mock.module("@/context/global-sync", () => ({
    useGlobalSync: () => ({ data: globalSyncData }),
  }))

  const module = await import("./use-session-todos")
  createSessionTodoModel = module.createSessionTodoModel
  isTodoSnapshotKnownForRestore = module.isTodoSnapshotKnownForRestore
})

describe("isTodoSnapshotKnownForRestore", () => {
  test("does not treat a non-none todo source as known without a sync cache", () => {
    expect(
      isTodoSnapshotKnownForRestore({
        sessionID: "s",
        testTodosKnown: false,
        source: "primary-backend",
        syncTodoKnown: false,
        globalTodoKnown: false,
      }),
    ).toBe(false)

    expect(
      isTodoSnapshotKnownForRestore({
        sessionID: "s",
        testTodosKnown: false,
        source: "primary-parts",
        syncTodoKnown: false,
        globalTodoKnown: false,
      }),
    ).toBe(false)
  })

  test("uses explicit sync caches as restored-known sources", () => {
    expect(
      isTodoSnapshotKnownForRestore({
        sessionID: "s",
        testTodosKnown: false,
        source: "none",
        syncTodoKnown: true,
        globalTodoKnown: false,
      }),
    ).toBe(true)

    expect(
      isTodoSnapshotKnownForRestore({
        sessionID: "s",
        testTodosKnown: false,
        source: "none",
        syncTodoKnown: false,
        globalTodoKnown: true,
      }),
    ).toBe(true)
  })
})

describe("createSessionTodoModel dock restore input", () => {
  test("keeps the first live tool-parts todo opening when backend cache has not primed", () => {
    const originalNow = Date.now
    Date.now = () => 200

    try {
      createRoot((dispose) => {
        const stores = createStore({
          message: { s: [{ id: "m1", sessionID: "s" } as Message] },
          part: {
            m1: [
              todoWritePart(
                completedState({
                  input: { todos: [todo("live task", "in_progress")] },
                  time: { start: 250, end: 250 },
                }),
              ),
            ],
          } as Record<string, Part[] | undefined>,
          todo: {} as Record<string, Todo[] | undefined>,
        })
        syncData = stores[0]
        globalSyncData = {
          session_todo: {},
          session_todo_clear: {},
        }

        const model = createSessionTodoModel({ sessionID: () => "s" })

        expect(model.snapshot()).toMatchObject({
          source: "primary-parts",
          sourceUpdatedAt: 250,
          phase: "active",
        })
        expect(model.opening()).toBe(true)

        dispose()
      })
    } finally {
      Date.now = originalNow
    }
  })
})
