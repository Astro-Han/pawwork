import { describe, expect, test } from "bun:test"

describe("startup migration marker", () => {
  test("uses the namespaced database path instead of a hard-coded OpenCode database", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text()

    expect(source).toMatch(/\bDatabase\.getChannelPath\(\)/)
    expect(source).not.toMatch(/path\.join\(\s*Global\.Path\.data\s*,\s*["'`]opencode\.db["'`]\s*\)/)
  })
})
