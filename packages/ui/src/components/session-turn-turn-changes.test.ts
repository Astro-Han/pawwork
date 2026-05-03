import { describe, expect, test } from "bun:test"
import { hasVisibleTurnChanges, type TurnChangeDisplay } from "./session-turn-changes"

const base = {
  sessionID: "ses",
  turnID: "msg",
  messageID: "msg",
  undoAvailable: false,
  redoAvailable: false,
} satisfies Omit<TurnChangeDisplay, "files">

describe("session turn changes", () => {
  test("shows truncated display even when no file rows are visible", () => {
    expect(
      hasVisibleTurnChanges({
        ...base,
        truncated: true,
        omittedCount: 1,
        files: [],
      }),
    ).toBe(true)
  })

  test("hides an empty non-truncated display", () => {
    expect(
      hasVisibleTurnChanges({
        ...base,
        files: [],
      }),
    ).toBe(false)
  })
})
