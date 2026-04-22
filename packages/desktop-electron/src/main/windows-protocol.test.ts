import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(resolve(import.meta.dir, "windows.ts"), "utf8")

describe("desktop packaged renderer protocol", () => {
  test("registers a privileged renderer scheme and loads packaged HTML from it", () => {
    expect(source).toContain("export function registerRendererScheme()")
    expect(source).toContain("protocol.registerSchemesAsPrivileged")
    expect(source).toContain("scheme: rendererProtocol")
    expect(source).toContain("secure: true")
    expect(source).toContain("standard: true")
    expect(source).toContain("corsEnabled: true")
    expect(source).toContain("supportFetchAPI: true")
    expect(source).toContain("protocol.handle(rendererProtocol")
    expect(source).toContain("net.fetch(pathToFileURL(file).toString())")
    expect(source).toContain("win.loadURL(rendererUrl(html))")
    expect(source).not.toContain("win.loadFile")
  })
})
