import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { promptPlaceholder } from "./placeholder"

describe("promptPlaceholder", () => {
  const t = (key: string) => key

  test("returns shell placeholder in shell mode", () => {
    expect(promptPlaceholder({ mode: "shell", commentCount: 0, t })).toBe("prompt.placeholder.shell")
  })

  test("returns summarize placeholders for comment context", () => {
    expect(promptPlaceholder({ mode: "normal", commentCount: 1, t })).toBe("prompt.placeholder.summarizeComment")
    expect(promptPlaceholder({ mode: "normal", commentCount: 2, t })).toBe("prompt.placeholder.summarizeComments")
  })

  test("returns static home placeholder for normal mode with no comments", () => {
    expect(promptPlaceholder({ mode: "normal", commentCount: 0, t })).toBe("prompt.placeholder.home")
  })
})

describe("prompt.placeholder.home copy", () => {
  test("hints at both @ for files and / for commands in English", () => {
    const copy = en["prompt.placeholder.home"]
    expect(copy).toContain("@")
    expect(copy).toContain("/")
  })

  test("hints at both @ for files and / for commands in Chinese", () => {
    const copy = zh["prompt.placeholder.home"]
    expect(copy).toContain("@")
    expect(copy).toContain("/")
  })
})
