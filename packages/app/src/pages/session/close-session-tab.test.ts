import { describe, expect, test } from "bun:test"
import { canCloseSessionTab, closeSessionTab } from "./close-session-tab"

describe("closeSessionTab", () => {
  test("closes an active file tab before the shell tab", () => {
    const calls: string[] = []

    const closed = closeSessionTab({
      closableTab: () => "file://src/a.ts",
      closeFileTab: (tab) => calls.push(`file:${tab}`),
      sidePanelOpened: () => false,
      sidePanelTab: () => "review",
      closeShellTab: (tab) => calls.push(`shell:${tab}`),
    })

    expect(closed).toBe(true)
    expect(calls).toEqual(["file:file://src/a.ts"])
  })

  test("falls back to closing the active shell tab", () => {
    const calls: string[] = []

    const closed = closeSessionTab({
      closableTab: () => undefined,
      closeFileTab: (tab) => calls.push(`file:${tab}`),
      sidePanelOpened: () => true,
      sidePanelTab: () => "context",
      closeShellTab: (tab) => calls.push(`shell:${tab}`),
    })

    expect(closed).toBe(true)
    expect(calls).toEqual(["shell:context"])
  })

  test("does not close the pinned status shell tab", () => {
    const calls: string[] = []

    const closed = closeSessionTab({
      closableTab: () => undefined,
      closeFileTab: (tab) => calls.push(`file:${tab}`),
      sidePanelOpened: () => true,
      sidePanelTab: () => "status",
      closeShellTab: (tab) => calls.push(`shell:${tab}`),
    })

    expect(closed).toBe(false)
    expect(calls).toEqual([])
  })

  test("does not close a hidden shell tab while the side panel is closed", () => {
    const calls: string[] = []

    const closed = closeSessionTab({
      closableTab: () => undefined,
      closeFileTab: (tab) => calls.push(`file:${tab}`),
      sidePanelOpened: () => false,
      sidePanelTab: () => "review",
      closeShellTab: (tab) => calls.push(`shell:${tab}`),
    })

    expect(closed).toBe(false)
    expect(calls).toEqual([])
  })
})

describe("canCloseSessionTab", () => {
  test("enables close for file tabs or non-status shell tabs", () => {
    expect(canCloseSessionTab(() => "file://src/a.ts", () => false, () => "status")).toBe(true)
    expect(canCloseSessionTab(() => undefined, () => true, () => "review")).toBe(true)
    expect(canCloseSessionTab(() => undefined, () => false, () => "review")).toBe(false)
    expect(canCloseSessionTab(() => undefined, () => true, () => "status")).toBe(false)
  })
})
