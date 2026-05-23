import { describe, expect, test } from "bun:test"
import type { Todo } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import { canAcceptSessionTodo, setSessionTodoSnapshot, type GlobalStore, type SessionTodoSnapshot } from "./global-sync"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./global-sync/eviction"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"

const globalStoreFixture = (): GlobalStore => ({
  ready: true,
  path: { state: "", config: "", worktree: "", directory: "", home: "" },
  project: [],
  session_todo: {},
  provider: { all: [], connected: [], default: {} },
  provider_auth: {},
  config: {},
  reload: undefined,
})

describe("canAcceptSessionTodo", () => {
  const todo = { id: "todo_1", content: "work", status: "in_progress", priority: "medium" } as Todo
  const snapshot = (revision: number): SessionTodoSnapshot => ({ revision, todos: [todo] })

  test("accepts the first canonical snapshot", () => {
    expect(canAcceptSessionTodo(undefined, snapshot(0))).toBe(true)
  })

  test("rejects stale or equal revisions", () => {
    expect(canAcceptSessionTodo(snapshot(2), snapshot(1))).toBe(false)
    expect(canAcceptSessionTodo(snapshot(2), snapshot(2))).toBe(false)
  })

  test("accepts newer revisions including authoritative empty snapshots", () => {
    expect(canAcceptSessionTodo(snapshot(2), { revision: 3, todos: [] })).toBe(true)
  })
})

describe("setSessionTodoSnapshot", () => {
  test("creates the canonical todo entry on first write", () => {
    const [store, setStore] = createStore<GlobalStore>(globalStoreFixture())
    const todo = { id: "todo_1", content: "work", status: "in_progress", priority: "medium" } as Todo

    setSessionTodoSnapshot(setStore, "ses_1", undefined, {
      revision: 1,
      todos: [todo],
    })

    expect(store.session_todo.ses_1).toEqual({ revision: 1, todos: [todo] })
  })

  test("updates todos through a keyed array path before writing revision", () => {
    const calls: unknown[][] = []
    const setStore = ((...input: unknown[]) => {
      calls.push(input)
      return input.at(-1)
    }) as Parameters<typeof setSessionTodoSnapshot>[0]
    const todo = { id: "todo_1", content: "work", status: "in_progress", priority: "medium" } as Todo
    const current = { revision: 1, todos: [] }

    setSessionTodoSnapshot(setStore, "ses_1", current, { revision: 2, todos: [todo] })

    expect(calls).toHaveLength(2)
    expect(calls[0].slice(0, 3)).toEqual(["session_todo", "ses_1", "todos"])
    expect(calls[1]).toEqual(["session_todo", "ses_1", "revision", 2])
  })
})

describe("pickDirectoriesToEvict", () => {
  test("keeps pinned stores and evicts idle stores", () => {
    const now = 5_000
    const picks = pickDirectoriesToEvict({
      stores: ["a", "b", "c", "d"],
      state: new Map([
        ["a", { lastAccessAt: 1_000 }],
        ["b", { lastAccessAt: 4_900 }],
        ["c", { lastAccessAt: 4_800 }],
        ["d", { lastAccessAt: 3_000 }],
      ]),
      pins: new Set(["a"]),
      max: 2,
      ttl: 1_500,
      now,
    })

    expect(picks).toEqual(["d", "c"])
  })
})

describe("loadRootSessionsWithFallback", () => {
  test("uses limited roots query when supported", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number; sort?: "created" }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 10,
      list: async (query) => {
        calls.push(query)
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(true)
    expect(calls).toEqual([{ directory: "dir", roots: true, limit: 10, sort: "created" }])
  })

  test("falls back to full roots query on limited-query failure", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number; sort?: "created" }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 25,
      list: async (query) => {
        calls.push(query)
        if (query.limit) throw new Error("unsupported")
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(false)
    expect(calls).toEqual([
      { directory: "dir", roots: true, limit: 25, sort: "created" },
      { directory: "dir", roots: true, sort: "created" },
    ])
  })
})

describe("estimateRootSessionTotal", () => {
  test("keeps exact total for full fetches", () => {
    expect(estimateRootSessionTotal({ count: 42, limit: 10, limited: false })).toBe(42)
  })

  test("marks has-more for full-limit limited fetches", () => {
    expect(estimateRootSessionTotal({ count: 10, limit: 10, limited: true })).toBe(11)
  })

  test("keeps exact total when limited fetch is under limit", () => {
    expect(estimateRootSessionTotal({ count: 9, limit: 10, limited: true })).toBe(9)
  })
})

describe("canDisposeDirectory", () => {
  test("rejects pinned or inflight directories", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: true,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: true,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: true,
      }),
    ).toBe(false)
  })

  test("accepts idle unpinned directory store", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(true)
  })
})
