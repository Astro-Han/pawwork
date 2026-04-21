import { describe, expect, test } from "bun:test"
import { normalizeLocale } from "./language"

describe("normalizeLocale", () => {
  test("keeps supported product locales", () => {
    expect(normalizeLocale("en")).toBe("en")
    expect(normalizeLocale("EN")).toBe("en")
    expect(normalizeLocale("zh")).toBe("zh")
  })

  test("maps legacy Traditional Chinese locale to Simplified Chinese", () => {
    expect(normalizeLocale("zht")).toBe("zh")
  })

  test("maps Chinese language tags to Simplified Chinese", () => {
    expect(normalizeLocale("zh-CN")).toBe("zh")
    expect(normalizeLocale("zh-Hans")).toBe("zh")
    expect(normalizeLocale("zh-Hant")).toBe("zh")
    expect(normalizeLocale("zh-TW")).toBe("zh")
    expect(normalizeLocale("zh-HK")).toBe("zh")
    expect(normalizeLocale("zh-MO")).toBe("zh")
    expect(normalizeLocale("zh_tw")).toBe("zh")
  })

  test("falls back to English for unsupported locales", () => {
    expect(normalizeLocale("fr")).toBe("en")
    expect(normalizeLocale("en-TW")).toBe("en")
    expect(normalizeLocale(42 as never)).toBe("en")
  })
})
