import { LOCAL_FETCH_PROVIDER_ID } from "@deepseek-ai/dsh-web-fetch-http"
import { describe, expect, test } from "vitest"
import { allRows, overlaidRows, readProductPatch } from "./dsh-product-patch.testing"

describe("PawWork web_fetch", () => {
  // Two halves, and either one alone is a broken product: the tool without the
  // provider answers `no usable web provider is registered` on every call, and
  // the provider without the tool is a service nothing can reach. dsh-base has
  // mounted the provider since 0.1.2-alpha.2 — PawWork only flips the tool on —
  // so this couples our row to the upstream row a DSH upgrade could retire.
  test("mounts the tool and its provider together", () => {
    const patch = readProductPatch()
    const tool = patch.find((entry) => entry.id === "tool-web")
    const providers = [...allRows(patch), ...overlaidRows()]

    expect(tool?.disabled).toBe(false)
    expect(tool?.config?.fetch).toBe(true)
    // Mounted and unconditionally on. Selected by id and checked across every
    // row carrying it, because retiring a row is done by id alone: dsh-web-app
    // already writes bare `- id: tool-web / disabled: true` rows that state no
    // name, so a search by name would read the row that mounts the provider and
    // never see the one that switches it off.
    //
    // The assertion is that the field is absent rather than not `true`, because
    // upstream writes it as a `!!js` expression on the sandbox rows, which loads
    // as its source text — any value at all, string or boolean, is a gate.
    const rows = providers.filter((row) => row.id === "web-fetch-http")
    expect(rows.map((row) => row.name)).toContain("@deepseek-ai/dsh-web-fetch-http")
    for (const row of rows) expect(row.disabled).toBeUndefined()
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
