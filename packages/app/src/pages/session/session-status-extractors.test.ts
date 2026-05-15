import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "bun:test"
import type { Part, ToolState } from "@opencode-ai/sdk/v2"
import {
  TOOL_TODOWRITE,
  TOOL_WEBFETCH,
  TOOL_WEBSEARCH,
  extractTodos,
  extractSources,
} from "./session-status-extractors"

const completedState = (
  overrides: Partial<Extract<ToolState, { status: "completed" }>> = {},
): Extract<ToolState, { status: "completed" }> => ({
  status: "completed",
  input: {},
  output: "",
  title: "",
  metadata: {},
  time: { start: 0, end: 0 },
  ...overrides,
})

const toolPart = (tool: string, state: ToolState = completedState()): Part =>
  ({
    id: "p",
    sessionID: "s",
    messageID: "m",
    type: "tool",
    callID: "c",
    tool,
    state,
  }) as Part

describe("extractTodos", () => {
  it("returns [] for empty parts", () => {
    expect(extractTodos([])).toEqual([])
  })

  it("ignores non-todowrite tool parts", () => {
    expect(extractTodos([toolPart("bash")])).toEqual([])
  })

  it("returns todos from the later todowrite call when two exist", () => {
    const older = toolPart(
      "todowrite",
      completedState({ input: { todos: [{ content: "old", status: "pending", priority: "low" }] } }),
    )
    const newer = toolPart(
      "todowrite",
      completedState({ input: { todos: [{ content: "new", status: "in_progress", priority: "high" }] } }),
    )
    expect(extractTodos([older, newer])).toEqual([{ content: "new", status: "in_progress", priority: "high" }])
  })

  it("skips todowrite parts that are not completed", () => {
    const running = toolPart("todowrite", {
      status: "running",
      input: { todos: [{ content: "x", status: "pending", priority: "low" }] },
      metadata: {},
      time: { start: 0 },
    } as ToolState)
    expect(extractTodos([running])).toEqual([])
  })

  it("filters malformed todo items", () => {
    const part = toolPart(
      "todowrite",
      completedState({ input: { todos: [{ content: "ok", status: "pending", priority: "low" }, { nope: true }] } }),
    )
    expect(extractTodos([part])).toEqual([{ content: "ok", status: "pending", priority: "low" }])
  })

  it("prefers resolved metadata todos with ids over idless tool input", () => {
    const part = toolPart(
      "todowrite",
      completedState({
        input: { todos: [{ content: "A", status: "pending", priority: "medium" }] },
        metadata: { todos: [{ id: "todo_1", content: "A", status: "pending", priority: "medium" }] },
      }),
    )

    expect(extractTodos([part])).toEqual([{ id: "todo_1", content: "A", status: "pending", priority: "medium" }])
  })

  it("falls back to tool input when metadata todos are malformed", () => {
    const part = toolPart(
      "todowrite",
      completedState({
        input: { todos: [{ content: "A", status: "pending", priority: "medium" }] },
        metadata: { todos: [{ id: "todo_1", content: "A", status: "pending" }] },
      }),
    )

    expect(extractTodos([part])).toEqual([{ content: "A", status: "pending", priority: "medium" }])
  })
})

const webfetchPart = (url: string): Part => toolPart("webfetch", completedState({ input: { url } }))

const websearchPart = (output: string): Part =>
  toolPart("websearch", completedState({ input: { query: "anything" }, output }))

describe("extractSources", () => {
  it("returns [] for empty parts", () => {
    expect(extractSources([])).toEqual([])
  })

  it("extracts webfetch URLs from input.url", () => {
    expect(extractSources([webfetchPart("https://example.com/a")])).toEqual(["https://example.com/a"])
  })

  it("extracts websearch URLs from output via http(s) regex", () => {
    const out = "Result 1: https://example.com/x\nResult 2: http://foo.bar/y"
    expect(extractSources([websearchPart(out)])).toEqual(["https://example.com/x", "http://foo.bar/y"])
  })

  it("dedupes URLs in first-seen order across all parts", () => {
    expect(
      extractSources([webfetchPart("https://a.com"), webfetchPart("https://a.com"), webfetchPart("https://b.com")]),
    ).toEqual(["https://a.com", "https://b.com"])
  })

  it("caps at 20 after dedupe", () => {
    const parts = Array.from({ length: 30 }, (_, i) => webfetchPart(`https://site-${i}.com`))
    expect(extractSources(parts)).toHaveLength(20)
  })

  it("captures URLs with balanced parens (e.g. wikipedia disambiguation)", () => {
    const out = "See https://en.wikipedia.org/wiki/Foo_(bar) and trailing) should not eat."
    const sources = extractSources([websearchPart(out)])
    expect(sources).toHaveLength(1)
    expect(sources[0]).toBe("https://en.wikipedia.org/wiki/Foo_(bar)")
  })

  it("dedupes URLs that differ only in scheme/host casing", () => {
    const sources = extractSources([webfetchPart("https://Example.com/p"), webfetchPart("https://example.com/p")])
    expect(sources).toHaveLength(1)
  })
})

describe("tool name sanity", () => {
  const OPENCODE_TOOL_DIR = join(import.meta.dirname, "../../../../opencode/src/tool")
  const cases: Array<[string, string]> = [
    [TOOL_TODOWRITE, "todo.ts"],
    [TOOL_WEBFETCH, "webfetch.ts"],
    [TOOL_WEBSEARCH, "websearch.ts"],
    ["question", "question.ts"],
  ]
  for (const [tool, filename] of cases) {
    it(`"${tool}" literal appears in packages/opencode/src/tool/${filename}`, () => {
      const source = readFileSync(join(OPENCODE_TOOL_DIR, filename), "utf8")
      expect(source.includes(`"${tool}"`)).toBe(true)
    })
  }
})
