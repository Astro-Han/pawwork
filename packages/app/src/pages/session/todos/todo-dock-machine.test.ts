import { describe, expect, test } from "bun:test"
import {
  createTodoDockRestoreTracker,
  reduceTodoDockState,
  todoDockHiddenState,
  type TodoDockMachineState,
} from "./todo-dock-machine"

const active = (sessionID = "s") => ({ sessionID, count: 1, phase: "active" as const, lifecycleSignature: "pending" })
const terminal = (sessionID = "s", lifecycleSignature = "completed") => ({
  sessionID,
  count: 1,
  phase: "terminal" as const,
  lifecycleSignature,
})
const empty = (sessionID = "s") => ({ sessionID, count: 0, phase: "empty" as const, lifecycleSignature: "" })

describe("reduceTodoDockState", () => {
  test("active todos show the dock", () => {
    expect(reduceTodoDockState(todoDockHiddenState(), { type: "snapshot", input: active() })).toMatchObject({
      kind: "visible-active",
      dock: true,
      completing: false,
    })
  })

  test("restored active todos show the dock without opening animation", () => {
    expect(
      reduceTodoDockState(todoDockHiddenState(), {
        type: "snapshot",
        input: { ...active(), restored: true },
      }),
    ).toMatchObject({
      kind: "visible-active",
      dock: true,
      opening: false,
      completing: false,
    })
  })

  test("active to terminal enters completing", () => {
    const shown = reduceTodoDockState(todoDockHiddenState(), { type: "snapshot", input: active() })

    expect(reduceTodoDockState(shown, { type: "snapshot", input: terminal() })).toMatchObject({
      kind: "visible-completing",
      dock: true,
      completing: true,
    })
  })

  test("active parts to terminal parts enters completing even without backend todos", () => {
    const shown = reduceTodoDockState(todoDockHiddenState(), { type: "snapshot", input: active() })

    expect(
      reduceTodoDockState(shown, {
        type: "snapshot",
        input: { ...terminal(), dockEligible: false, historicalTerminal: true },
      }),
    ).toMatchObject({ kind: "visible-completing", dock: true, completing: true })
  })

  test("hide timer hides only the matching terminal snapshot", () => {
    const completing = reduceTodoDockState(
      reduceTodoDockState(todoDockHiddenState(), { type: "snapshot", input: active() }),
      { type: "snapshot", input: terminal("s", "completed") },
    )

    expect(
      reduceTodoDockState(completing, { type: "hideTimerElapsed", sessionID: "s", lifecycleSignature: "completed" }),
    ).toMatchObject({ kind: "hidden-terminal", dock: false })
    expect(
      reduceTodoDockState(completing, {
        type: "hideTimerElapsed",
        sessionID: "other",
        lifecycleSignature: "completed",
      }),
    ).toBe(completing)
  })

  test("terminal content-only refresh keeps the same completing state", () => {
    const completing = reduceTodoDockState(
      reduceTodoDockState(todoDockHiddenState(), { type: "snapshot", input: active() }),
      { type: "snapshot", input: terminal("s", "completed") },
    )

    expect(reduceTodoDockState(completing, { type: "snapshot", input: terminal("s", "completed") })).toBe(completing)
  })

  test("terminal replacement with same statuses but new lifecycle signature updates completing state", () => {
    const shown = reduceTodoDockState(todoDockHiddenState(), { type: "snapshot", input: active("s") })
    const completing = reduceTodoDockState(shown, {
      type: "snapshot",
      input: terminal("s", JSON.stringify([["todo_1", "completed"]])),
    })

    const replaced = reduceTodoDockState(completing, {
      type: "snapshot",
      input: terminal("s", JSON.stringify([["todo_2", "completed"]])),
    })

    expect(replaced).toMatchObject({
      kind: "visible-completing",
      lifecycleSignature: JSON.stringify([["todo_2", "completed"]]),
    })
  })

  test("empty hides immediately", () => {
    const shown = reduceTodoDockState(todoDockHiddenState(), { type: "snapshot", input: active() })

    expect(reduceTodoDockState(shown, { type: "snapshot", input: empty() })).toMatchObject({
      kind: "hidden",
      dock: false,
    })
  })

  test("new active cancels completing", () => {
    const completing = reduceTodoDockState(
      reduceTodoDockState(todoDockHiddenState(), { type: "snapshot", input: active() }),
      { type: "snapshot", input: terminal() },
    )

    expect(reduceTodoDockState(completing, { type: "snapshot", input: active() })).toMatchObject({
      kind: "visible-active",
      completing: false,
    })
  })

  test("session switch does not inherit active history", () => {
    const activeSession = reduceTodoDockState(todoDockHiddenState(), { type: "snapshot", input: active("s") })

    expect(reduceTodoDockState(activeSession, { type: "snapshot", input: terminal("other") })).toMatchObject({
      kind: "hidden-terminal",
      dock: false,
    })
  })

  test("leaving a completing session consumes its transient active history", () => {
    const completing = reduceTodoDockState(
      reduceTodoDockState(todoDockHiddenState(), { type: "snapshot", input: active("a") }),
      { type: "snapshot", input: terminal("a") },
    )
    const other = reduceTodoDockState(completing, { type: "snapshot", input: empty("b") })

    expect(reduceTodoDockState(other, { type: "snapshot", input: terminal("a") })).toMatchObject({
      kind: "hidden-terminal",
      sessionID: "a",
      dock: false,
    })
  })

  test("landing on completed-only historical session stays hidden", () => {
    const state: TodoDockMachineState = todoDockHiddenState()

    expect(reduceTodoDockState(state, { type: "snapshot", input: terminal() })).toMatchObject({
      kind: "hidden-terminal",
      dock: false,
    })
  })
})

describe("createTodoDockRestoreTracker", () => {
  test("marks the first known active snapshot after an unknown session entry as restored", () => {
    const restored = createTodoDockRestoreTracker()

    expect(restored({ sessionID: "s", known: false, count: 0, phase: "empty" })).toBe(false)
    expect(restored({ sessionID: "s", known: true, count: 1, phase: "active" })).toBe(true)
    expect(restored({ sessionID: "s", known: true, count: 1, phase: "active" })).toBe(false)
  })

  test("does not mark live todos as restored after a known empty snapshot primes the session", () => {
    const restored = createTodoDockRestoreTracker()

    expect(restored({ sessionID: "s", known: true, count: 0, phase: "empty" })).toBe(false)
    expect(restored({ sessionID: "s", known: true, count: 1, phase: "active" })).toBe(false)
  })

  test("marks historical tool-parts todos as restored on session entry", () => {
    const restored = createTodoDockRestoreTracker(() => 200)

    expect(restored({ sessionID: "s", known: false, count: 0, phase: "empty" })).toBe(false)
    expect(
      restored({
        sessionID: "s",
        known: false,
        count: 1,
        phase: "active",
        source: "primary-parts",
        sourceUpdatedAt: 100,
      }),
    ).toBe(true)
  })

  test("marks first tool-parts todos without timestamps as restored on session entry", () => {
    const restored = createTodoDockRestoreTracker(() => 200)

    expect(restored({ sessionID: "s", known: false, count: 0, phase: "empty" })).toBe(false)
    expect(
      restored({
        sessionID: "s",
        known: false,
        count: 1,
        phase: "active",
        source: "primary-parts",
      }),
    ).toBe(true)
  })

  test("does not mark newly observed tool-parts todos as restored after session entry", () => {
    const restored = createTodoDockRestoreTracker(() => 200)

    expect(restored({ sessionID: "s", known: false, count: 0, phase: "empty" })).toBe(false)
    expect(
      restored({
        sessionID: "s",
        known: true,
        count: 1,
        phase: "active",
        source: "primary-parts",
        sourceUpdatedAt: 250,
      }),
    ).toBe(false)
  })

  test("marks timestamped historical tool-parts todos as restored after a known empty snapshot primes the session", () => {
    const restored = createTodoDockRestoreTracker(() => 200)

    expect(restored({ sessionID: "s", known: true, count: 0, phase: "empty" })).toBe(false)
    expect(
      restored({
        sessionID: "s",
        known: false,
        count: 1,
        phase: "active",
        source: "primary-parts",
        sourceUpdatedAt: 100,
      }),
    ).toBe(true)
  })

  test("shows timestamped historical tool-parts without opening after a known empty snapshot primes the session", () => {
    const restored = createTodoDockRestoreTracker(() => 200)
    let state = reduceTodoDockState(todoDockHiddenState(), {
      type: "snapshot",
      input: { sessionID: "s", count: 0, phase: "empty", lifecycleSignature: "[]" },
    })

    expect(restored({ sessionID: "s", known: true, count: 0, phase: "empty" })).toBe(false)

    const restoredInput = restored({
      sessionID: "s",
      known: false,
      count: 1,
      phase: "active",
      source: "primary-parts",
      sourceUpdatedAt: 100,
    })
    state = reduceTodoDockState(state, {
      type: "snapshot",
      input: {
        sessionID: "s",
        count: 1,
        phase: "active",
        lifecycleSignature: "[pending]",
        restored: restoredInput,
      },
    })

    expect(restoredInput).toBe(true)
    expect(state).toMatchObject({ dock: true, opening: false })
  })

  test("does not mark live tool-parts todos as restored after a known empty snapshot primes the session", () => {
    const restored = createTodoDockRestoreTracker()
    const liveToolPartsSnapshot = {
      sessionID: "s",
      known: true,
      count: 1,
      phase: "active" as const,
      source: "primary-parts" as const,
    }

    expect(restored({ sessionID: "s", known: true, count: 0, phase: "empty" })).toBe(false)
    expect(restored(liveToolPartsSnapshot)).toBe(false)
  })
})
