import { describe, expect, test } from "bun:test"
import { isAgentToolPart } from "@/cli/cmd/run"

describe("CLI run dual-match dispatch (#128)", () => {
  test("'task' tool id satisfies dispatch predicate (legacy-session compat)", () => {
    expect(isAgentToolPart("task")).toBe(true) // agent-rename:legacy-render
  })

  test("'agent' tool id satisfies dispatch predicate (current)", () => {
    expect(isAgentToolPart("agent")).toBe(true)
  })

  test("other tool ids do not satisfy the dispatch predicate", () => {
    expect(isAgentToolPart("bash")).toBe(false)
    expect(isAgentToolPart("read")).toBe(false)
    expect(isAgentToolPart("")).toBe(false)
  })
})
