import { describe, expect, test } from "bun:test"
import { loadOpenCliAdapters, searchOpenCliCommands } from "../../src/opencli/adapter-registry"

describe("opencli adapter registry", () => {
  test("loads the packaged manifest and exposes searchable canonical commands", async () => {
    const loaded = await loadOpenCliAdapters()

    expect(loaded.manifestCount).toBe(1050)
    expect(loaded.canonicalCommands.has("12306/me")).toBe(true)
    expect(loaded.canonicalCommands.has("hackernews/search")).toBe(true)
    expect(loaded.exposedCommands.has("instagram/reel")).toBe(false)

    const results = await searchOpenCliCommands("12306 account", { limit: 5 })
    expect(results[0]).toMatchObject({
      name: "12306/me",
      access: "read",
      browser: true,
    })
  })
})
