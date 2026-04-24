import { describe, expect, test } from "bun:test"
import { detectSystemMenuLocale, menuLabel, parseMenuLocale, parseStoredMenuLocale } from "./menu-labels"

describe("menu labels", () => {
  test("parses supported locale values", () => {
    expect(parseMenuLocale("zh")).toBe("zh")
    expect(parseMenuLocale("zh_Hant_TW")).toBe("zh")
    expect(parseMenuLocale({ locale: "zht" })).toBe("zh")
    expect(parseMenuLocale(JSON.stringify({ locale: "zh-Hant" }))).toBe("zh")
    expect(parseMenuLocale(JSON.stringify({ locale: "en" }))).toBe("en")
    expect(parseMenuLocale("en-US")).toBe("en")
  })

  test("falls back to English for unknown locale values", () => {
    expect(parseMenuLocale("fr")).toBe("en")
    expect(parseMenuLocale({ locale: "fr" })).toBe("en")
    expect(parseMenuLocale(null)).toBe("en")
  })

  test("only treats valid stored locale values as explicit preferences", () => {
    expect(parseStoredMenuLocale(JSON.stringify({ locale: "zh" }))).toBe("zh")
    expect(parseStoredMenuLocale(JSON.stringify({ locale: "en" }))).toBe("en")
    expect(parseStoredMenuLocale({ locale: "en-US" })).toBe("en")
    expect(parseStoredMenuLocale("zh")).toBe("zh")
    expect(parseStoredMenuLocale("en")).toBe("en")
    expect(parseStoredMenuLocale({ locale: "fr" })).toBeUndefined()
    expect(parseStoredMenuLocale("fr")).toBeUndefined()
    expect(parseStoredMenuLocale("{")).toBeUndefined()
  })

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
    expect(menuLabel("zh", "reportProblem")).toBe("报告问题")
    expect(menuLabel("zh", "pawworkOnGithub")).toBe("在 GitHub 上查看爪印")
    expect(menuLabel("fr" as never, "file")).toBe("File")
  })
})
