import { describe, expect, test } from "bun:test"
import { isTodoSnapshotKnownForRestore } from "./use-session-todos"

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
