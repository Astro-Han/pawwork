import { describe, expect, test } from "bun:test"
import { dict as zh } from "./zh"

describe("zh branding copy", () => {
  test("uses Chinese product naming on key user-facing surfaces", () => {
    expect(zh["dialog.model.unpaid.freeModels.title"]).toBe("爪印内置免费模型")
    expect(zh["sidebar.gettingStarted.line1"]).toBe("爪印内置免费模型，你可以立即开始使用。")
    expect(zh["app.name.desktop"]).toBe("爪印")
    expect(zh["toast.update.description"]).toBe("爪印有新版本 ({{version}}) 可安装。")
    expect(zh["error.page.report.prefix"]).toBe("请将此错误报告给开发团队")
  })

  test("removes standalone PawWork from curated Chinese UI strings", () => {
    const curatedKeys = [
      "dialog.model.unpaid.freeModels.title",
      "sidebar.gettingStarted.line1",
      "app.name.desktop",
      "toast.update.description",
      "error.page.report.prefix",
    ] as const

    for (const key of curatedKeys) {
      expect(zh[key]).not.toContain("PawWork")
    }
  })

  test("never ships a standalone PawWork anywhere in the Chinese dict", () => {
    // The curated list above only spot-checks a few surfaces; the brand rule is
    // global — every Chinese string says 爪印, never PawWork. Scan the whole dict
    // so a new key can't reintroduce the English name unnoticed.
    const offenders = Object.entries(zh)
      .filter(([, value]) => typeof value === "string" && value.includes("PawWork"))
      .map(([key]) => key)
    expect(offenders).toEqual([])
  })
})
