import { describe, expect, test } from "bun:test"
import { detectSystemMenuLocale, menuLabel } from "./menu-labels"

describe("menu labels", () => {
  test("detects supported system locale prefixes", () => {
    expect(detectSystemMenuLocale("zh-CN")).toBe("zh")
    expect(detectSystemMenuLocale("zh-TW")).toBe("zh")
    expect(detectSystemMenuLocale("zh-Hant-TW")).toBe("zh")
    expect(detectSystemMenuLocale("en-US")).toBe("en")
    expect(detectSystemMenuLocale("fr-FR")).toBe("en")
    expect(detectSystemMenuLocale(null)).toBe("en")
    expect(detectSystemMenuLocale(undefined)).toBe("en")
  })

  test("returns custom labels for simplified Chinese", () => {
    expect(menuLabel("zh", "file")).toBe("文件")
    expect(menuLabel("zh", "reloadWindow")).toBe("重新加载窗口")
    expect(menuLabel("zh", "pawworkOnGithub")).toBe("在 GitHub 上查看爪印")
  })
})
