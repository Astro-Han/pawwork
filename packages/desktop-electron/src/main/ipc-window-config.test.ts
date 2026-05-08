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

  test("registers renderer diagnostics channels for sandboxed renderers", () => {
    expect(source).toContain('"renderer-diagnostics:record"')
    expect(source).toContain('"renderer-diagnostics:export"')
    expect(source).toContain("recordRendererDiagnostic")
    expect(source).toContain("exportRendererDiagnostics")
    expect(source).toContain("rendererDiagnosticsSlice")
  })

  test("store-get returns null when persisted store reads fail", () => {
    const start = source.indexOf('ipcMain.handle("store-get"')
    const end = source.indexOf('ipcMain.handle("store-set"', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const handler = source.slice(start, end)

    expect(handler).toContain("try {")
    expect(handler).toContain("getStore(name)")
    expect(handler).toContain("catch")
    expect(handler).toContain("return null")
  })
})
