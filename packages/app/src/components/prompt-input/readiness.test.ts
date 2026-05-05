import { describe, expect, test } from "bun:test"
import { promptKeyActionReady, promptSendDisabled } from "./readiness"

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
})

describe("promptSendDisabled", () => {
  test("uses abort readiness only for the stop state", () => {
    expect(
      promptSendDisabled({
        stopping: true,
        actionReady: false,
        abortReady: true,
        blank: true,
        selectedSkill: false,
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
        selectedSkill: false,
      }),
    ).toBe(true)
  })
})
