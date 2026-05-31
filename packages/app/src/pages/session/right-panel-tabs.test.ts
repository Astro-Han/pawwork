import { describe, expect, test } from "bun:test"

import {
  coerceLegacySidePanelTab,
  defaultRightPanelTab,
  isDanglingTerminalSelection,
  isRightPanelTab,
  isRightPanelTerminalTab,
  migrateLegacyRightPanelTab,
  normalizeShellTabs,
  RIGHT_PANEL_TAB_VALUES,
  shouldCommitDeferredOpen,
  terminalTabValue,
  type RightPanelTab,
} from "./right-panel-tabs"

describe("right panel tab helpers", () => {
  test("defaults to status for sessions without stored tab", () => {
    expect(defaultRightPanelTab()).toBe("status")
  })

  test("migrates old changes tab to review", () => {
    expect(migrateLegacyRightPanelTab("changes")).toBe("review")
  })

  test("migrates old files tab to status", () => {
    expect(migrateLegacyRightPanelTab("files")).toBe("status")
  })

  test("keeps new right panel tabs stable", () => {
    const tabs: RightPanelTab[] = ["status", "review", "context"]
    expect(tabs.map((tab) => migrateLegacyRightPanelTab(tab))).toEqual(tabs)
  })

  test("drops legacy 'terminal' static value (terminals now come from terminal.all)", () => {
    expect(migrateLegacyRightPanelTab("terminal")).toBe("status")
  })
})

describe("isRightPanelTab", () => {
  test("accepts all static tabs", () => {
    for (const tab of RIGHT_PANEL_TAB_VALUES) expect(isRightPanelTab(tab)).toBe(true)
  })

  test("rejects unknown strings and non-strings", () => {
    expect(isRightPanelTab("changes")).toBe(false)
    expect(isRightPanelTab("files")).toBe(false)
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

  test("maps files to status", () => {
    expect(coerceLegacySidePanelTab("files")).toBe("status")
  })

  test("passes through known tabs", () => {
    expect(coerceLegacySidePanelTab("status")).toBe("status")
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
    expect(normalizeShellTabs({ openShellTabs: ["review", "context"], sidePanelTab: "review" })).toEqual({
      openShellTabs: ["status", "review", "context"],
      sidePanelTab: "review",
    })
  })

  test("dedupes preserving first occurrence", () => {
    expect(
      normalizeShellTabs({ openShellTabs: ["status", "review", "review", "context"], sidePanelTab: "context" }),
    ).toEqual({
      openShellTabs: ["status", "review", "context"],
      sidePanelTab: "context",
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
    expect(normalizeShellTabs({ openShellTabs: ["status", "review"], sidePanelTab: "context" })).toEqual({
      openShellTabs: ["status", "review"],
      sidePanelTab: "status",
    })
  })

  test("idempotent", () => {
    const once = normalizeShellTabs({ openShellTabs: ["review", "status", "review"], sidePanelTab: "review" })
    const twice = normalizeShellTabs(once)
    expect(twice).toEqual(once)
  })

  test("drops legacy files from persisted openShellTabs", () => {
    const result = normalizeShellTabs({ openShellTabs: ["status", "files"], sidePanelTab: "files" })
    expect(result.openShellTabs).toEqual(["status"])
    expect(result.sidePanelTab).toBe("status")
  })
})

describe("terminalTabValue", () => {
  test("builds a terminal tab value that isRightPanelTerminalTab accepts", () => {
    const value = terminalTabValue("abc")
    expect(value).toBe("terminal:abc")
    expect(isRightPanelTerminalTab(value)).toBe(true)
  })

  test("throws on an empty id rather than returning the invalid 'terminal:'", () => {
    expect(() => terminalTabValue("")).toThrow()
    expect(isRightPanelTerminalTab("terminal:")).toBe(false)
  })
})

describe("isDanglingTerminalSelection", () => {
  test("not dangling while terminal store is still hydrating (ready=false)", () => {
    expect(isDanglingTerminalSelection("terminal:t1" as RightPanelTab, false, [])).toBe(false)
  })

  test("dangling once ready and the id is absent", () => {
    expect(isDanglingTerminalSelection("terminal:gone" as RightPanelTab, true, ["t1", "t2"])).toBe(true)
  })

  test("not dangling once ready and the id is present", () => {
    expect(isDanglingTerminalSelection("terminal:t2" as RightPanelTab, true, ["t1", "t2"])).toBe(false)
  })

  test("static tabs are never dangling, ready or not", () => {
    expect(isDanglingTerminalSelection("status", true, [])).toBe(false)
    expect(isDanglingTerminalSelection("review", false, [])).toBe(false)
  })
})

describe("shouldCommitDeferredOpen", () => {
  test("commits when chip still open and baseline selection unchanged", () => {
    const after = normalizeShellTabs({ openShellTabs: ["status", "review"], sidePanelTab: "status" })
    expect(shouldCommitDeferredOpen(after, "review", "status")).toBe(true)
  })

  test("skips when chip was closed before microtask fired", () => {
    const after = normalizeShellTabs({ openShellTabs: ["status"], sidePanelTab: "status" })
    expect(shouldCommitDeferredOpen(after, "review", "status")).toBe(false)
  })

  test("skips when a same-tick openTab(B) moved selection off baseline", () => {
    const after = normalizeShellTabs({
      openShellTabs: ["status", "review", "context"],
      sidePanelTab: "context",
    })
    expect(shouldCommitDeferredOpen(after, "review", "status")).toBe(false)
  })

  test("skips when selection moved off baseline to a different open tab", () => {
    const after = normalizeShellTabs({
      openShellTabs: ["status", "review", "context"],
      sidePanelTab: "context",
    })
    expect(shouldCommitDeferredOpen(after, "review", "status")).toBe(false)
  })

  test("never commits for a terminal target (terminal chips skip the defer path entirely)", () => {
    const after = normalizeShellTabs({ openShellTabs: ["status"], sidePanelTab: "status" })
    expect(shouldCommitDeferredOpen(after, "terminal:abc" as RightPanelTab, "status")).toBe(false)
  })
})
