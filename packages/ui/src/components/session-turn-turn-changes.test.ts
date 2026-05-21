import { describe, expect, test } from "bun:test"
import {
  hasTurnChangeActionHandler,
  hasVisibleTurnChanges,
  turnChangeAction,
  type TurnChangeDisplay,
} from "./session-turn-changes"

const base = {
  sessionID: "ses",
  turnID: "msg",
  messageID: "msg",
} satisfies Omit<TurnChangeDisplay, "files" | "kind">

describe("session turn changes", () => {
  test("shows truncated display even when no file rows are visible", () => {
    expect(
      hasVisibleTurnChanges({
        ...base,
        kind: "captured",
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
        kind: "captured",
        files: [],
      }),
    ).toBe(false)
  })

  test("requires the matching handler before showing an undo or redo action", () => {
    const undoDisplay: TurnChangeDisplay = {
      ...base,
      kind: "captured",
      files: [{ path: "file.txt", status: "modified", expandable: false, restoreState: "applied" }],
    }
    const redoDisplay: TurnChangeDisplay = {
      ...base,
      kind: "captured",
      files: [{ path: "file.txt", status: "modified", expandable: false, restoreState: "undone" }],
    }

    expect(turnChangeAction(undoDisplay)).toBe("undo")
    expect(hasTurnChangeActionHandler(undoDisplay, {})).toBe(false)
    expect(hasTurnChangeActionHandler(undoDisplay, { undo: () => undefined })).toBe(true)
    expect(turnChangeAction(redoDisplay)).toBe("redo")
    expect(hasTurnChangeActionHandler(redoDisplay, { undo: () => undefined })).toBe(false)
    expect(hasTurnChangeActionHandler(redoDisplay, { redo: () => undefined })).toBe(true)
  })
})
