import { describe, expect, test } from "vitest"
import { readProductPatch } from "./dsh-product-patch.testing"

describe("PawWork web_fetch", () => {
  // Two halves, and either one alone is a broken product: the tool without the
  // provider answers `no usable web provider is registered` on every call, and
  // the provider without the tool is a service nothing can reach. They sit in
  // different rows of the same file, so nothing but this couples them.
  test("mounts the tool and its provider together", () => {
    const patch = readProductPatch()
    const tool = patch.find((entry) => entry.id === "tool-web")
    const providers = patch.flatMap((entry) => entry.insert ?? [])

    expect(tool?.disabled).toBe(false)
    expect(tool?.config?.fetch).toBe(true)
    expect(providers.some((row) => row.name === "@deepseek-ai/dsh-web-fetch-http")).toBe(true)
  })

  // The agent presets each mount their own scoped `tool-web` for `web_search`.
  // Leaving search on here would register a second one into the global layer,
  // resolved against whatever provider the host composition happens to hold
  // rather than the preset's — a silently different search for the same name.
  test("leaves web_search to the preset that already owns it", () => {
    const tool = readProductPatch().find((entry) => entry.id === "tool-web")

    expect(tool?.config?.search).toBe(false)
  })
})
