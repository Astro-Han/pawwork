import { describe, expect, test } from "bun:test"
import { getRegistry, type CliCommand } from "@jackwener/opencli/registry"
import path from "path"
import { pathToFileURL } from "url"
import {
  AdapterRegistry,
  importOpenCliAdapterModulesForTest,
  loadOpenCliAdapters,
  searchOpenCliCommands,
  type OpenCliManifestEntry,
} from "../../src/opencli/adapter-registry"

describe("opencli adapter registry", () => {
  test("exposes the module namespace export", () => {
    expect(AdapterRegistry.searchOpenCliCommands).toBe(searchOpenCliCommands)
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

  test("continues loading later adapter modules after one import fails", async () => {
    const manifest = [
      { site: "bad", name: "fail", access: "read", type: "js", modulePath: "bad.js" },
      { site: "good", name: "ok", access: "read", type: "js", modulePath: "good.js" },
    ] satisfies OpenCliManifestEntry[]
    const imported: string[] = []

    const failures = await importOpenCliAdapterModulesForTest(manifest, {
      root: "/opencli",
      importModule: async (specifier) => {
        imported.push(specifier)
        if (specifier.endsWith("/bad.js")) throw new Error("bad module")
      },
    })

    expect(imported).toEqual([
      pathToFileURL(path.join("/opencli", "clis", "bad.js")).href,
      pathToFileURL(path.join("/opencli", "clis", "good.js")).href,
    ])
    expect(failures).toEqual([{ modulePath: "bad.js", error: "bad module" }])
  })
})
