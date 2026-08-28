import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { describe, expect, test } from "vitest"
import { readEntryList, readProductPatch, type EntryRow } from "./dsh-product-patch.testing"

type ConditionalEntry = EntryRow & { disabled?: boolean | string; insert?: ConditionalEntry[] }

const browseInteraction = [
  {
    id: "directory-picker-browse-host",
    name: "@deepseek-ai/dsh-host-directory-picker-browse",
  },
  {
    id: "directory-picker-browse-client",
    name: "@deepseek-ai/dsh-client-ui-directory-picker-browse",
  },
]

function disabledOn(entry: ConditionalEntry, platform: "darwin" | "linux" | "win32") {
  if (typeof entry.disabled !== "string") return entry.disabled ?? false

  return Function("process", `return (${entry.disabled})`)({ platform }) as boolean
}

describe("PawWork DSH directory picker composition", () => {
  test("uses the official browse interaction on Windows while preserving auto elsewhere", () => {
    const patch = readProductPatch() as ConditionalEntry[]
    const auto = patch.find((entry) => entry.id === "directory-picker")
    const inserted = patch.flatMap((entry) => entry.insert ?? [])
    const browse = browseInteraction.map(({ id, name }) =>
      inserted.find((entry) => entry.id === id && entry.name === name),
    )

    expect(auto).toBeDefined()
    expect(browse).not.toContain(undefined)

    expect(disabledOn(auto!, "win32")).toBe(true)
    expect(browse.every((entry) => disabledOn(entry!, "win32") === false)).toBe(true)

    for (const platform of ["darwin", "linux"] as const) {
      expect(disabledOn(auto!, platform)).toBe(false)
      expect(browse.every((entry) => disabledOn(entry!, platform) === true)).toBe(true)
    }
  })

  test("replaces the picker declared by the pinned web app with its matching host and client pair", () => {
    const require = createRequire(import.meta.url)
    const webAppPatch = require.resolve("@deepseek-ai/dsh-web-app/cordis.patch.yml")
    const declared = readEntryList(webAppPatch).flatMap((entry) => entry.insert ?? [])
    const hostManifest = JSON.parse(
      readFileSync(require.resolve("@deepseek-ai/dsh-host-directory-picker-browse/package.json"), "utf8"),
    )
    const clientManifest = JSON.parse(
      readFileSync(require.resolve("@deepseek-ai/dsh-client-ui-directory-picker-browse/package.json"), "utf8"),
    )

    expect(declared).toContainEqual({
      id: "directory-picker",
      name: "@deepseek-ai/dsh-host-directory-picker-auto",
    })
    expect(hostManifest.name).toBe(browseInteraction[0].name)
    expect(clientManifest.name).toBe(browseInteraction[1].name)
    expect(clientManifest.exports["./client"].default).toBe("./lib/client.js")
    expect(clientManifest.dsh.client.platform).toBe("web")
  })
})
