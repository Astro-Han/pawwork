import { describe, expect, test } from "bun:test"

import {
  coerceLegacySidePanelTab,
  defaultRightPanelTab,
  isRightPanelTab,
  migrateLegacyRightPanelTab,
  normalizeShellTabs,
  RIGHT_PANEL_TAB_VALUES,
  shouldCommitDeferredOpen,
  type RightPanelTab,
} from "./right-panel-tabs"

describe("right panel tab helpers", () => {
  test("defaults to status for sessions without stored tab", () => {
    expect(defaultRightPanelTab()).toBe("status")
  })

  test("migrates old changes tab to review", () => {
    expect(migrateLegacyRightPanelTab("changes")).toBe("review")
  })

  test("migrates old files tab to files", () => {
    expect(migrateLegacyRightPanelTab("files")).toBe("files")
  })

  test("keeps new right panel tabs stable", () => {
    const tabs: RightPanelTab[] = ["status", "files", "review", "context"]
    expect(tabs.map((tab) => migrateLegacyRightPanelTab(tab))).toEqual(tabs)
  })

  test("drops legacy 'terminal' static value (terminals now come from terminal.all)", () => {
    // Pre-refactor 'terminal' was a fixed slot. After flattening, only
    // dynamic 'terminal:<id>' is valid; the bare value falls back to status.
    expect(migrateLegacyRightPanelTab("terminal")).toBe("status")
  })
})

describe("isRightPanelTab", () => {
  test("accepts all static tabs", () => {
    for (const tab of RIGHT_PANEL_TAB_VALUES) expect(isRightPanelTab(tab)).toBe(true)
  })

  test("rejects unknown strings and non-strings", () => {
    expect(isRightPanelTab("changes")).toBe(false)
    expect(isRightPanelTab(undefined)).toBe(false)
    expect(isRightPanelTab(123)).toBe(false)
    expect(isRightPanelTab(null)).toBe(false)
  })

  test("rejects bare 'terminal' (post-refactor: only dynamic ids are valid)", () => {
    expect(isRightPanelTab("terminal")).toBe(false)
  })

  test("accepts terminal:<non-empty id>", () => {
    expect(isRightPanelTab("terminal:abc123")).toBe(true)
    expect(isRightPanelTab("terminal:42")).toBe(true)
    expect(isRightPanelTab("terminal:t_8f3-xyz")).toBe(true)
  })

  test("rejects empty terminal id", () => {
    expect(isRightPanelTab("terminal:")).toBe(false)
  })

  test("rejects other dynamic prefixes", () => {
    expect(isRightPanelTab("files:xyz")).toBe(false)
    expect(isRightPanelTab("review:abc")).toBe(false)
  })
})

describe("coerceLegacySidePanelTab", () => {
  test("maps changes to review", () => {
    expect(coerceLegacySidePanelTab("changes")).toBe("review")
  })

  test("passes through known tabs", () => {
    expect(coerceLegacySidePanelTab("status")).toBe("status")
    expect(coerceLegacySidePanelTab("files")).toBe("files")
    expect(coerceLegacySidePanelTab("context")).toBe("context")
  })

  test("returns undefined for unknown values", () => {
    expect(coerceLegacySidePanelTab(undefined)).toBe(undefined)
    expect(coerceLegacySidePanelTab("foo")).toBe(undefined)
    expect(coerceLegacySidePanelTab(42)).toBe(undefined)
  })
})

describe("normalizeShellTabs", () => {
  test("empty input returns status-only", () => {
    expect(normalizeShellTabs({ openShellTabs: undefined, sidePanelTab: undefined })).toEqual({
      openShellTabs: ["status"],
      sidePanelTab: "status",
    })
  })

  test("non-array openShellTabs coerces to status-only", () => {
    expect(normalizeShellTabs({ openShellTabs: "review", sidePanelTab: "review" })).toEqual({
      openShellTabs: ["status"],
      sidePanelTab: "status",
    })
  })

  test("injects status at head if missing", () => {
    expect(normalizeShellTabs({ openShellTabs: ["files", "review"], sidePanelTab: "files" })).toEqual({
      openShellTabs: ["status", "files", "review"],
      sidePanelTab: "files",
    })
  })

  test("dedupes preserving first occurrence", () => {
    expect(
      normalizeShellTabs({ openShellTabs: ["status", "files", "files", "review"], sidePanelTab: "review" }),
    ).toEqual({
      openShellTabs: ["status", "files", "review"],
      sidePanelTab: "review",
    })
  })

  test("drops invalid tab values", () => {
    expect(normalizeShellTabs({ openShellTabs: ["status", "changes", 123, "review"], sidePanelTab: "review" })).toEqual(
      {
        openShellTabs: ["status", "review"],
        sidePanelTab: "review",
      },
    )
  })

  test("falls back to status when sidePanelTab not in list", () => {
    expect(normalizeShellTabs({ openShellTabs: ["status", "files"], sidePanelTab: "review" })).toEqual({
      openShellTabs: ["status", "files"],
      sidePanelTab: "status",
    })
  })

  test("idempotent", () => {
    const once = normalizeShellTabs({ openShellTabs: ["files", "status", "files"], sidePanelTab: "files" })
    const twice = normalizeShellTabs(once)
    expect(twice).toEqual(once)
  })
})

describe("shouldCommitDeferredOpen", () => {
  // Scenario: openTab("files") scheduled a microtask while baseline was "status".
  // By the time the microtask runs, evaluate whether the deferred selection
  // write to "files" is still safe.

  test("commits when chip still open and baseline selection unchanged", () => {
    const after = normalizeShellTabs({ openShellTabs: ["status", "files"], sidePanelTab: "status" })
    expect(shouldCommitDeferredOpen(after, "files", "status")).toBe(true)
  })

  test("skips when chip was closed before microtask fired", () => {
    const after = normalizeShellTabs({ openShellTabs: ["status"], sidePanelTab: "status" })
    expect(shouldCommitDeferredOpen(after, "files", "status")).toBe(false)
  })

  test("skips when a same-tick openTab(B) moved selection off baseline", () => {
    // Sequence: openTab("files") defers, openTab("review") commits sync to
    // "review". The deferred microtask must not overwrite "review".
    const after = normalizeShellTabs({
      openShellTabs: ["status", "files", "review"],
      sidePanelTab: "review",
    })
    expect(shouldCommitDeferredOpen(after, "files", "status")).toBe(false)
  })

  test("skips when selection moved off baseline to a different open tab", () => {
    const after = normalizeShellTabs({
      openShellTabs: ["status", "files", "context"],
      sidePanelTab: "context",
    })
    // Baseline was "status"; by microtask time selection is on "context".
    // Don't overwrite that with the deferred "files".
    expect(shouldCommitDeferredOpen(after, "files", "status")).toBe(false)
  })

  test("never commits for a terminal target (terminal chips skip the defer path entirely)", () => {
    const after = normalizeShellTabs({ openShellTabs: ["status"], sidePanelTab: "status" })
    expect(shouldCommitDeferredOpen(after, "terminal:abc" as RightPanelTab, "status")).toBe(false)
  })
})
