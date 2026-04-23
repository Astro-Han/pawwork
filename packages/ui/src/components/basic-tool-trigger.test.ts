import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("BasicTool trigger rendering avoids Solid Switch for dynamic JSX triggers", () => {
  const source = readFileSync(new URL("./basic-tool.tsx", import.meta.url), "utf8")
  const triggerInfoStart = source.indexOf("const triggerInfo = () =>")
  const triggerStart = source.indexOf("const trigger = () =>", triggerInfoStart)
  expect(triggerInfoStart).toBeGreaterThanOrEqual(0)
  expect(triggerStart).toBeGreaterThan(triggerInfoStart)
  const triggerSource = source.slice(triggerInfoStart, triggerStart)

  expect(triggerSource).not.toMatch(/<\s*Switch\b/)
  expect(triggerSource).not.toMatch(/<\s*Match\b[^>]*\bwhen=\{\s*isTriggerTitle\(props\.trigger\)/)
})
