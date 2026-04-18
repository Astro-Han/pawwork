import { describe, expect, test } from "bun:test"

import { defaultRightPanelTab, migrateLegacyRightPanelTab, type RightPanelTab } from "./right-panel-tabs"

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
    const tabs: RightPanelTab[] = ["status", "files", "review", "terminal"]
    expect(tabs.map((tab) => migrateLegacyRightPanelTab(tab))).toEqual(tabs)
  })
})
