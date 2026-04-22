import { describe, expect, test } from "bun:test"

describe("startup migration marker", () => {
  test("uses the namespaced database path instead of a hard-coded OpenCode database", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text()

    expect(source).toContain("Database.getChannelPath()")
    expect(source).not.toContain('path.join(Global.Path.data, "opencode.db")')
  })
})
