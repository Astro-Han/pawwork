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
    expect(openShellTab(base, "review")).toEqual({ openShellTabs: ["status", "review"], sidePanelTab: "review" })
  })

  test("openShellTab on existing tab only sets active", () => {
    const start = openShellTab(openShellTab(base, "review"), "context")
    const next = openShellTab(start, "review")
    expect(next.openShellTabs).toEqual(["status", "review", "context"])
    expect(next.sidePanelTab).toBe("review")
  })

  test("closeShellTab status is no-op", () => {
    expect(closeShellTab(base, "status")).toEqual(base)
  })

  test("closeShellTab on active falls back to left neighbor", () => {
    const start = openShellTab(openShellTab(base, "review"), "context")
    expect(closeShellTab(start, "context")).toEqual({ openShellTabs: ["status", "review"], sidePanelTab: "review" })
  })

  test("closeShellTab on active with no left neighbor falls back to status", () => {
    const start = openShellTab(base, "review")
    expect(closeShellTab(start, "review")).toEqual({ openShellTabs: ["status"], sidePanelTab: "status" })
  })

  test("closeShellTab on non-active preserves active", () => {
    const start = openShellTab(openShellTab(base, "review"), "context")
    expect(closeShellTab(start, "review")).toEqual({ openShellTabs: ["status", "context"], sidePanelTab: "context" })
  })

  test("closeShellTab on an active terminal tab shifts selection to status, openShellTabs untouched", () => {
    const start = openShellTab(base, "terminal:x")
    expect(start).toEqual({ openShellTabs: ["status"], sidePanelTab: "terminal:x" })
    expect(closeShellTab(start, "terminal:x")).toEqual({ openShellTabs: ["status"], sidePanelTab: "status" })
  })

  test("toggleShellTab opens when not in list", () => {
    const next = toggleShellTab(base, "review", true)
    expect(next.closePanel).toBe(false)
    expect(next.state).toEqual({ openShellTabs: ["status", "review"], sidePanelTab: "review" })
  })

  test("toggleShellTab on inactive in-list tab only activates", () => {
    const start = openShellTab(openShellTab(base, "review"), "context")
    const next = toggleShellTab(start, "review", true)
    expect(next.closePanel).toBe(false)
    expect(next.state.openShellTabs).toEqual(["status", "review", "context"])
    expect(next.state.sidePanelTab).toBe("review")
  })

  test("toggleShellTab on active but panel closed activates", () => {
    const start = openShellTab(base, "review")
    const next = toggleShellTab(start, "review", false)
    expect(next.closePanel).toBe(false)
    expect(next.state.sidePanelTab).toBe("review")
  })

  test("toggleShellTab on active and panel open closes the panel without removing the tab", () => {
    const start = openShellTab(base, "review")
    const next = toggleShellTab(start, "review", true)
    expect(next.closePanel).toBe(true)
    expect(next.state.openShellTabs).toEqual(["status", "review"])
    expect(next.state.sidePanelTab).toBe("review")
  })

  test("toggleShellTab status never closes", () => {
    const next = toggleShellTab(base, "status", true)
    expect(next.closePanel).toBe(false)
    expect(next.state).toEqual(base)
  })

  test("moveShellTab reorders non-status tabs and keeps active", () => {
    const start = openShellTab(openShellTab(base, "review"), "context")
    expect(moveShellTab(start, "context", 1)).toEqual({
      openShellTabs: ["status", "context", "review"],
      sidePanelTab: "context",
    })
  })

  test("moveShellTab cannot move status", () => {
    const start = openShellTab(base, "review")
    expect(moveShellTab(start, "status", 1)).toEqual(start)
  })

  test("moveShellTab clamps negative indexes after the pinned status tab", () => {
    const start = openShellTab(openShellTab(base, "review"), "context")
    expect(moveShellTab(start, "context", -1).openShellTabs).toEqual(["status", "context", "review"])
  })

  test("normalizeShellTabs maps legacy files tab to status", () => {
    const result = normalizeShellTabs({ openShellTabs: ["status", "files" as any], sidePanelTab: "files" })
    expect(result.openShellTabs).toEqual(["status"])
    expect(result.sidePanelTab).toBe("status")
  })
})
