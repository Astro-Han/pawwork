import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(resolve(import.meta.dir, "windows.ts"), "utf8")

describe("desktop windows security", () => {
  test("renderer windows use a sandbox-compatible preload bridge without renderer Node access", () => {
    expect(source.match(/preload: join\(root, "\.\.\/preload\/index\.js"\)/g)).toHaveLength(2)
    expect(source.match(/sandbox: true/g)).toHaveLength(2)
    expect(source.match(/contextIsolation: true/g)).toHaveLength(2)
    expect(source.match(/nodeIntegration: false/g)).toHaveLength(2)
    expect(source).not.toContain("executeJavaScript")
  })
})
