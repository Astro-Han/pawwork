import { describe, expect, test } from "bun:test"
import {
  promptKeyActionReady,
  promptSendDisabled,
  shouldActivateShellModeFromBang,
  shouldExitShellModeOnBackspace,
} from "./readiness"

describe("promptKeyActionReady", () => {
  test("gates the ESC interrupt on abort readiness while working", () => {
    expect(
      promptKeyActionReady({
        key: "Escape",
        working: true,
        actionReady: false,
        abortReady: true,
      }),
    ).toBe(true)

    expect(
      promptKeyActionReady({
        key: "Escape",
        working: true,
        actionReady: true,
        abortReady: false,
      }),
    ).toBe(false)
  })

  test("gates Enter on submit readiness, never on abort readiness", () => {
    // Enter only submits — it must not ride on abort readiness even while a
    // task is running, so it can never interrupt that task.
    expect(
      promptKeyActionReady({
        key: "Enter",
        working: true,
        actionReady: false,
        abortReady: true,
      }),
    ).toBe(false)

    expect(
      promptKeyActionReady({
        key: "Enter",
        working: true,
        actionReady: true,
        abortReady: false,
      }),
    ).toBe(true)
  })

  test("allows local navigation while submit is blocked", () => {
    expect(
      promptKeyActionReady({
        key: "ArrowUp",
        working: false,
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

describe("shouldExitShellModeOnBackspace", () => {
  test("exits shell mode when caret is at the start of an empty shell prompt and action is ready", () => {
    expect(
      shouldExitShellModeOnBackspace({
        mode: "shell",
        collapsed: true,
        cursorPosition: 0,
        textLength: 0,
        actionReady: true,
      }),
    ).toBe(true)
  })

  test("ignores backspace exit while the prompt is not action-ready", () => {
    expect(
      shouldExitShellModeOnBackspace({
        mode: "shell",
        collapsed: true,
        cursorPosition: 0,
        textLength: 0,
        actionReady: false,
      }),
    ).toBe(false)
  })

  test("ignores backspace exit while in normal mode", () => {
    expect(
      shouldExitShellModeOnBackspace({
        mode: "normal",
        collapsed: true,
        cursorPosition: 0,
        textLength: 0,
        actionReady: true,
      }),
    ).toBe(false)
  })

  test("ignores backspace exit when the prompt is not empty", () => {
    expect(
      shouldExitShellModeOnBackspace({
        mode: "shell",
        collapsed: true,
        cursorPosition: 0,
        textLength: 3,
        actionReady: true,
      }),
    ).toBe(false)
  })

  test("ignores backspace exit when the selection is not collapsed", () => {
    expect(
      shouldExitShellModeOnBackspace({
        mode: "shell",
        collapsed: false,
        cursorPosition: 0,
        textLength: 0,
        actionReady: true,
      }),
    ).toBe(false)
  })
})
