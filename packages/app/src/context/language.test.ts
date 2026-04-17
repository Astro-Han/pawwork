import { describe, expect, test } from "bun:test"
import { isTraditionalChinese } from "./language"

describe("isTraditionalChinese", () => {
  test("returns true for BCP-47 Hant tag", () => {
    expect(isTraditionalChinese("zh-hant")).toBe(true)
    expect(isTraditionalChinese("zh-hant-tw")).toBe(true)
  })

  test("returns true for Traditional Chinese region tags", () => {
    expect(isTraditionalChinese("zh-tw")).toBe(true)
    expect(isTraditionalChinese("zh-hk")).toBe(true)
    expect(isTraditionalChinese("zh-mo")).toBe(true)
    expect(isTraditionalChinese("zh_tw")).toBe(true)
  })

  test("returns false for Simplified Chinese and other locales", () => {
    expect(isTraditionalChinese("zh")).toBe(false)
    expect(isTraditionalChinese("zh-cn")).toBe(false)
    expect(isTraditionalChinese("zh-hans")).toBe(false)
    expect(isTraditionalChinese("en")).toBe(false)
    expect(isTraditionalChinese("en-tw")).toBe(false)
  })
})
