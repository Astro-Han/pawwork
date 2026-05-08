import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(resolve(import.meta.dir, "webview-zoom.ts"), "utf8")

describe("desktop renderer webview zoom", () => {
  test("only consumes keydown events that actually change zoom", () => {
    expect(source).toContain('if (event.key === "-") {')
    expect(source).toContain('if (event.key === "=" || event.key === "+") {')
    expect(source).toContain('if (event.key === "0") {')
    expect(source.match(/event\.preventDefault\(\)/g)?.length).toBe(3)
    expect(source).not.toContain("let newZoom = webviewZoom()")
  })

  test("keeps requested zoom separate until Electron accepts the zoom change", () => {
    expect(source).toContain("let requestedZoom = 1")
    expect(source).toContain("requestedZoom = next")
    expect(source).toContain("if (requestedZoom !== next) return")
    expect(source).toContain("setWebviewZoom(next)")
  })
})
