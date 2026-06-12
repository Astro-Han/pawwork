import { describe, expect, test } from "bun:test"
import { getRegistry, type CliCommand } from "@jackwener/opencli/registry"
import {
  AdapterRegistry,
  loadOpenCliAdapters,
  openCliCommand,
  searchOpenCliCommands,
} from "../../src/opencli/adapter-registry"

describe("opencli adapter registry", () => {
  test("exposes the module namespace export", () => {
    expect(AdapterRegistry.searchOpenCliCommands).toBe(searchOpenCliCommands)
  })

  test("searches the packaged manifest without importing adapter modules", async () => {
    getRegistry().delete("spotify/play")

    const results = await searchOpenCliCommands("spotify play", { limit: 5 })

    expect(results.map((result) => result.name)).toContain("spotify/play")
    expect(getRegistry().has("spotify/play")).toBe(false)
  })

  test("loads the packaged manifest and exposes searchable canonical commands", async () => {
    const loaded = await loadOpenCliAdapters()

    expect(loaded.manifestCount).toBeGreaterThan(1000)
    expect(loaded.canonicalCommands.has("12306/me")).toBe(true)
    expect(loaded.canonicalCommands.has("hackernews/search")).toBe(true)
    expect(loaded.exposedCommands.has("instagram/reel")).toBe(false)

    const results = await searchOpenCliCommands("12306 account", { limit: 5 })
    expect(results[0]).toMatchObject({
      name: "12306/me",
      access: "read",
      browser: true,
    })
    expect(loaded.failedModules).toEqual([])
  })

  test("lazily imports a bundled adapter module when resolving a command", async () => {
    getRegistry().delete("12306/me")

    const command = await openCliCommand("12306/me")

    expect(command).toMatchObject({ site: "12306", name: "me" })
    expect(getRegistry().has("12306/me")).toBe(true)
  })

  test("indexes commands with implicit browser support as browser commands", async () => {
    const command = {
      site: "000-pawwork-implicit",
      name: "implicit",
      access: "read",
      description: "Implicit test adapter",
      args: [],
      func: async () => [],
    } satisfies CliCommand
    getRegistry().set("000-pawwork-implicit/implicit", command)

    try {
      const results = await searchOpenCliCommands("browser", { limit: 1 })

      expect(results[0]?.name).toBe("000-pawwork-implicit/implicit")
      expect(results[0]?.browser).toBe(true)
    } finally {
      getRegistry().delete("000-pawwork-implicit/implicit")
    }
  })

})
