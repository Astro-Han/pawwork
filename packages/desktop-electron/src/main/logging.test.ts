import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(resolve(import.meta.dir, "logging.ts"), "utf8")

describe("desktop logging", () => {
  test("disables the console transport after a broken pipe", () => {
    expect(source).toContain("initConsoleTransport()")
    expect(source).toContain("log.transports.console.writeFn")
    expect(source).toContain('err.code === "EPIPE"')
    expect(source).toContain("log.transports.console.level = false")
  })
})
