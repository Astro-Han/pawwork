import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { LOCAL_FETCH_PROVIDER_ID } from "@deepseek-ai/dsh-web-fetch-http"
import { describe, expect, test } from "vitest"
import { readEntryList, readProductPatch } from "./dsh-product-patch.testing"

/** The dsh-base composition PawWork's product patch overlays. */
function baseEntryList() {
  const require = createRequire(import.meta.url)
  return readEntryList(join(dirname(require.resolve("@deepseek-ai/dsh-base/package.json")), "cordis.patch.yml"))
}

/** Every row a composition mounts, whether stated at top level or inserted. */
function allRows(entries: ReturnType<typeof readEntryList>) {
  return entries.flatMap((entry) => [entry, ...(entry.insert ?? [])])
}

describe("PawWork web_fetch", () => {
  // Two halves, and either one alone is a broken product: the tool without the
  // provider answers `no usable web provider is registered` on every call, and
  // the provider without the tool is a service nothing can reach. dsh-base has
  // mounted the provider since 0.1.2-alpha.2 — PawWork only flips the tool on —
  // so this couples our row to the upstream row a DSH upgrade could retire.
  test("mounts the tool and its provider together", () => {
    const patch = readProductPatch()
    const tool = patch.find((entry) => entry.id === "tool-web")
    const providers = [...allRows(patch), ...allRows(baseEntryList())]

    expect(tool?.disabled).toBe(false)
    expect(tool?.config?.fetch).toBe(true)
    expect(providers.some((row) => row.name === "@deepseek-ai/dsh-web-fetch-http")).toBe(true)
    // The seam picks the sole registered provider when nothing names one, so an
    // id that matches no provider fails only once a second one is mounted —
    // which is also the moment it stops being obvious why fetches began failing.
    expect(patch.find((entry) => entry.id === "web")?.config?.fetchProvider).toBe(
      LOCAL_FETCH_PROVIDER_ID,
    )
  })

  // The agent presets each mount their own scoped `tool-web`, and a scoped tool
  // shadows a global one of the same name. Both resolve the same `web` service,
  // so a second registration here would not search differently — it would be
  // dead weight that also drops the preset's own 60s search timeout.
  test("leaves web_search to the preset that already owns it", () => {
    const tool = readProductPatch().find((entry) => entry.id === "tool-web")

    expect(tool?.config?.search).toBe(false)
  })
})
