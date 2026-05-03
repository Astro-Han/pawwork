import { describe, expect, test } from "bun:test"
import { reduceTodoDockState, todoDockHiddenState, type TodoDockMachineState } from "./todo-dock-machine"

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
