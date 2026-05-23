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

test("legacy diff fallback is gated by visible turn-change data", () => {
  const source = readFileSync(new URL("./session-turn.tsx", import.meta.url), "utf8")

  expect(source).toContain("!hasVisibleTurnChanges(turnChange()) && diffs().length > 0 && !working()")
  expect(source).not.toContain("props.turnChanges === undefined &&")
})

test("turn-change expansion state stays owned by session turn", () => {
  const turnSource = readFileSync(new URL("./session-turn.tsx", import.meta.url), "utf8")
  const panelSource = readFileSync(new URL("./session-turn-changes-panel.tsx", import.meta.url), "utf8")

  expect(turnSource).toContain("const [turnExpanded, setTurnExpanded] = createSignal<string[]>([])")
  expect(turnSource).toContain("expanded={turnExpanded()}")
  expect(turnSource).toContain("onExpandedChange={(value) => setTurnExpanded(value)}")
  expect(panelSource).not.toContain("const [turnExpanded, setTurnExpanded] = createSignal<string[]>([])")
})

test("visible turn-change memo is declared after working state", () => {
  const source = readFileSync(new URL("./session-turn.tsx", import.meta.url), "utf8")

  expect(source.indexOf("const working = createMemo")).toBeLessThan(source.indexOf("const visibleTurnChange = createMemo"))
})

test("assistant content aria-hidden is driven by focus-safe state", () => {
  const source = readFileSync(new URL("./session-turn.tsx", import.meta.url), "utf8")

  const blurIndex = source.indexOf("if (shouldHide) blurActiveElementInside(assistantContent())")
  const hideIndex = source.indexOf("setAssistantHidden(shouldHide)")

  expect(source).toContain('import { blurActiveElementInside } from "./session-turn-focus"')
  expect(source).toContain("const [assistantContent, setAssistantContent] = createSignal<HTMLElement>()")
  expect(source).toContain("const [assistantHidden, setAssistantHidden] = createSignal(false)")
  expect(blurIndex).toBeGreaterThanOrEqual(0)
  expect(hideIndex).toBeGreaterThanOrEqual(0)
  expect(blurIndex).toBeLessThan(hideIndex)
  expect(source).toContain("aria-hidden={assistantHidden()}")
  expect(source).toContain("onFocusIn={() =>")
  expect(source).not.toContain("aria-hidden={working()}")
})
