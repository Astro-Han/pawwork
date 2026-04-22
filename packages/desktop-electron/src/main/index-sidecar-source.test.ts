import { describe, expect, test } from "bun:test"

describe("desktop sidecar source guard", () => {
  test("publishes PawWork credentials and does not block on stale migration probes", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text()

    expect(source).toContain("username: PAWWORK_RUNTIME.serverUsername")
    expect(source).toContain("const needsMigration = false")
    expect(source).not.toContain("sqliteFileExists")
    expect(source).not.toContain('username: "opencode"')
  })
})
