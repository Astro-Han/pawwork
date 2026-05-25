import { describe, expect, test } from "bun:test"

import {
  closeShellTab,
  moveShellTab,
  normalizeShellTabs,
  openShellTab,
  toggleShellTab,
} from "@/pages/session/right-panel-tabs"

describe("shell tab transitions", () => {
  const base = normalizeShellTabs({ openShellTabs: ["status"], sidePanelTab: "status" })

  test("openShellTab appends to end and sets active", () => {
    expect(openShellTab(base, "files")).toEqual({ openShellTabs: ["status", "files"], sidePanelTab: "files" })
  })

  test("openShellTab on existing tab only sets active", () => {
    const start = openShellTab(openShellTab(base, "files"), "review")
    const next = openShellTab(start, "files")
    expect(next.openShellTabs).toEqual(["status", "files", "review"])
    expect(next.sidePanelTab).toBe("files")
  })

  test("closeShellTab status is no-op", () => {
    expect(closeShellTab(base, "status")).toEqual(base)
  })

  test("closeShellTab on active falls back to left neighbor", () => {
    const start = openShellTab(openShellTab(base, "files"), "review")
    expect(closeShellTab(start, "review")).toEqual({ openShellTabs: ["status", "files"], sidePanelTab: "files" })
  })

  test("closeShellTab on active with no left neighbor falls back to status", () => {
    const start = openShellTab(base, "files")
    expect(closeShellTab(start, "files")).toEqual({ openShellTabs: ["status"], sidePanelTab: "status" })
  })

  test("closeShellTab on non-active preserves active", () => {
    const start = openShellTab(openShellTab(base, "files"), "review")
    expect(closeShellTab(start, "files")).toEqual({ openShellTabs: ["status", "review"], sidePanelTab: "review" })
  })

  test("toggleShellTab opens when not in list", () => {
    const next = toggleShellTab(base, "files", true)
    expect(next.closePanel).toBe(false)
    expect(next.state).toEqual({ openShellTabs: ["status", "files"], sidePanelTab: "files" })
  })

  test("toggleShellTab on inactive in-list tab only activates", () => {
    const start = openShellTab(openShellTab(base, "files"), "review")
    const next = toggleShellTab(start, "files", true)
    expect(next.closePanel).toBe(false)
    expect(next.state.openShellTabs).toEqual(["status", "files", "review"])
    expect(next.state.sidePanelTab).toBe("files")
  })

  test("toggleShellTab on active but panel closed activates", () => {
    const start = openShellTab(base, "files")
    const next = toggleShellTab(start, "files", false)
    expect(next.closePanel).toBe(false)
    expect(next.state.sidePanelTab).toBe("files")
  })

  test("toggleShellTab on active and panel open closes the panel without removing the tab", () => {
    const start = openShellTab(base, "files")
    const next = toggleShellTab(start, "files", true)
    expect(next.closePanel).toBe(true)
    expect(next.state.openShellTabs).toEqual(["status", "files"])
    expect(next.state.sidePanelTab).toBe("files")
  })

  test("toggleShellTab status never closes", () => {
    const next = toggleShellTab(base, "status", true)
    expect(next.closePanel).toBe(false)
    expect(next.state).toEqual(base)
  })

  test("moveShellTab reorders non-status tabs and keeps active", () => {
    const start = openShellTab(openShellTab(openShellTab(base, "files"), "review"), "context")
    expect(moveShellTab(start, "context", 1)).toEqual({
      openShellTabs: ["status", "context", "files", "review"],
      sidePanelTab: "context",
    })
  })

  test("moveShellTab cannot move status", () => {
    const start = openShellTab(base, "files")
    expect(moveShellTab(start, "status", 1)).toEqual(start)
  })

  test("moveShellTab clamps negative indexes after the pinned status tab", () => {
    const start = openShellTab(openShellTab(openShellTab(base, "files"), "review"), "context")
    expect(moveShellTab(start, "review", -1).openShellTabs).toEqual(["status", "review", "files", "context"])
  })
})
