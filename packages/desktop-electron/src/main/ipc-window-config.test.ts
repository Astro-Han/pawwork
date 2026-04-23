import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(resolve(import.meta.dir, "ipc.ts"), "utf8")

describe("desktop startup IPC", () => {
  test("registers window config and initial deep link channels for sandboxed renderers", () => {
    expect(source).toContain('"get-window-config"')
    expect(source).toContain('"consume-initial-deep-links"')
    expect(source).toContain("getWindowConfig")
    expect(source).toContain("consumeInitialDeepLinks")
  })

  test("registers problem report channel for renderer error pages", () => {
    expect(source).toContain('"report-problem"')
    expect(source).toContain("reportProblem")
  })
})
