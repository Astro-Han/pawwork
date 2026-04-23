import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("session turn collects assistant messages by parent id across the full message list", () => {
  const source = readFileSync(new URL("./session-turn.tsx", import.meta.url), "utf8")

  expect(source).toContain("messages")
  expect(source).toContain(".slice(messageIndex() + 1)")
  expect(source).toContain(".filter")
  expect(source).toContain("if (messageIndex() < 0) return emptyAssistant")
  expect(source).toContain('item.role === "assistant"')
  expect(source).toContain("item.parentID === msg.id")
  expect(source).not.toContain('if (item.role === "user") break')
})
