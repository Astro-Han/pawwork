import { describe, expect, test } from "bun:test"
import { getRegistry, type CliCommand } from "@jackwener/opencli/registry"
import {
  AdapterRegistry,
  openCliCommand,
  searchOpenCliCommands,
} from "../../src/opencli/adapter-registry"

describe("opencli adapter registry", () => {
  test("exposes the module namespace export", () => {
    expect(AdapterRegistry.searchOpenCliCommands).toBe(searchOpenCliCommands)
  })

  test("searches the packaged manifest without importing adapter modules", async () => {
    getRegistry().delete("hackernews/search")

    const results = await searchOpenCliCommands("hackernews search", { limit: 5 })

    expect(results.map((result) => result.name)).toContain("hackernews/search")
    expect(getRegistry().has("hackernews/search")).toBe(false)
  })

  test("searches packaged manifest commands and hides blocked commands", async () => {
    const results = await searchOpenCliCommands("12306 account", { limit: 5 })
    expect(results[0]).toMatchObject({
      name: "12306/me",
      access: "read",
      browser: true,
    })

    const hackerNews = await searchOpenCliCommands("hackernews search", { limit: 5 })
    expect(hackerNews.map((result) => result.name)).toContain("hackernews/search")

    const blocked = await searchOpenCliCommands("instagram reel", { limit: 25 })
    expect(blocked.map((result) => result.name)).not.toContain("instagram/reel")
    expect(await openCliCommand("instagram/reel")).toBeUndefined()
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
