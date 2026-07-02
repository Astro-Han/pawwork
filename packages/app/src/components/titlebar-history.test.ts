import { describe, expect, test } from "bun:test"
import { applyPath, backPath, forwardPath, type TitlebarHistory } from "./titlebar-history"

function history(): TitlebarHistory {
  return { stack: [], index: 0, action: undefined }
}

function entry(to: string, state?: unknown) {
  return { to, state }
}

describe("titlebar history", () => {
  test("append and trim keeps max bounded", () => {
    let state = history()
    state = applyPath(state, entry("/"), 3)
    state = applyPath(state, entry("/a"), 3)
    state = applyPath(state, entry("/b"), 3)
    state = applyPath(state, entry("/c"), 3)

    expect(state.stack.map((x) => x.to)).toEqual(["/a", "/b", "/c"])
    expect(state.stack.length).toBe(3)
    expect(state.index).toBe(2)
  })

  test("back and forward indexes stay correct after trimming", () => {
    let state = history()
    state = applyPath(state, entry("/"), 3)
    state = applyPath(state, entry("/a"), 3)
    state = applyPath(state, entry("/b"), 3)
    state = applyPath(state, entry("/c"), 3)

    expect(state.stack.map((x) => x.to)).toEqual(["/a", "/b", "/c"])
    expect(state.index).toBe(2)

    const back = backPath(state)
    expect(back?.entry.to).toBe("/b")
    expect(back?.state.index).toBe(1)

    const afterBack = applyPath(back!.state, back!.entry, 3)
    expect(afterBack.stack.map((x) => x.to)).toEqual(["/a", "/b", "/c"])
    expect(afterBack.index).toBe(1)

    const forward = forwardPath(afterBack)
    expect(forward?.entry.to).toBe("/c")
    expect(forward?.state.index).toBe(2)

    const afterForward = applyPath(forward!.state, forward!.entry, 3)
    expect(afterForward.stack.map((x) => x.to)).toEqual(["/a", "/b", "/c"])
    expect(afterForward.index).toBe(2)
  })

  test("action-driven navigation does not push duplicate history entries", () => {
    const state: TitlebarHistory = {
      stack: [entry("/"), entry("/a"), entry("/b")],
      index: 2,
      action: undefined,
    }

    const back = backPath(state)
    expect(back?.entry.to).toBe("/a")

    const next = applyPath(back!.state, back!.entry, 10)
    expect(next.stack.map((x) => x.to)).toEqual(["/", "/a", "/b"])
    expect(next.index).toBe(1)
    expect(next.action).toBeUndefined()
  })

  test("replaying an entry preserves its navigation state", () => {
    const origins = { origins: [{ pathname: "/dir/session/ses_1", search: "" }] }
    let state = history()
    state = applyPath(state, entry("/dir/session/ses_1"))
    state = applyPath(state, entry("/automations", origins))
    state = applyPath(state, entry("/settings", origins))

    const back = backPath(state)
    expect(back?.entry.to).toBe("/automations")
    expect(back?.entry.state).toBe(origins)
  })

  test("same path with new navigation state refreshes the stored entry without pushing", () => {
    const first = { automationID: "auto_1" }
    const second = { automationID: "auto_2" }
    let state = history()
    state = applyPath(state, entry("/automations", first))
    state = applyPath(state, entry("/automations", second))

    expect(state.stack.map((x) => x.to)).toEqual(["/", "/automations"])
    expect(state.stack.at(-1)?.state).toBe(second)
    expect(state.index).toBe(1)
  })
})
