import { describe, expect, test } from "bun:test"
import { promptKeyActionReady, promptSendDisabled, shouldActivateShellModeFromBang } from "./readiness"

describe("promptKeyActionReady", () => {
  test("allows keyboard stop when submit is blocked but abort is ready", () => {
    expect(
      promptKeyActionReady({
        key: "Escape",
        working: true,
        stopping: false,
        actionReady: false,
        abortReady: true,
      }),
    ).toBe(true)

    expect(
      promptKeyActionReady({
        key: "Enter",
        working: true,
        stopping: true,
        actionReady: false,
        abortReady: true,
      }),
    ).toBe(true)
  })

  test("keeps submit keys blocked when neither submit nor abort is ready", () => {
    expect(
      promptKeyActionReady({
        key: "Enter",
        working: true,
        stopping: true,
        actionReady: false,
        abortReady: false,
      }),
    ).toBe(false)
  })

  test("allows local navigation while submit is blocked", () => {
    expect(
      promptKeyActionReady({
        key: "ArrowUp",
        working: false,
        stopping: false,
        actionReady: false,
        abortReady: true,
      }),
    ).toBe(true)
  })

  test("allows local text input while submit is blocked", () => {
    expect(
      promptKeyActionReady({
        key: "a",
        working: false,
        stopping: false,
        actionReady: false,
        abortReady: true,
      }),
    ).toBe(true)
  })
})

describe("promptSendDisabled", () => {
  test("uses abort readiness only for the stop state", () => {
    expect(
      promptSendDisabled({
        stopping: true,
        actionReady: false,
        abortReady: true,
        blank: true,
      }),
    ).toBe(false)
  })

  test("keeps nonblank send disabled when submit readiness is blocked", () => {
    expect(
      promptSendDisabled({
        stopping: false,
        actionReady: false,
        abortReady: true,
        blank: false,
      }),
    ).toBe(true)
  })
})

describe("shouldActivateShellModeFromBang", () => {
  test("switches into shell mode at the start of a normal-mode prompt when action is ready", () => {
    expect(
      shouldActivateShellModeFromBang({ cursorPosition: 0, mode: "normal", actionReady: true }),
    ).toBe(true)
  })

  test("ignores the bang shortcut while the prompt is not action-ready", () => {
    expect(
      shouldActivateShellModeFromBang({ cursorPosition: 0, mode: "normal", actionReady: false }),
    ).toBe(false)
  })

  test("ignores the bang shortcut when the cursor is not at the start", () => {
    expect(
      shouldActivateShellModeFromBang({ cursorPosition: 3, mode: "normal", actionReady: true }),
    ).toBe(false)
  })

  test("ignores the bang shortcut when already in shell mode", () => {
    expect(
      shouldActivateShellModeFromBang({ cursorPosition: 0, mode: "shell", actionReady: true }),
    ).toBe(false)
  })
})
