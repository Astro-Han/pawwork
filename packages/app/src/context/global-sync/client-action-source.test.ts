import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const globalSyncSource = readFileSync(new URL("../global-sync.tsx", import.meta.url), "utf8")
const settingsProvidersSource = readFileSync(
  new URL("../../components/settings-providers.tsx", import.meta.url),
  "utf8",
)
const layoutSource = readFileSync(new URL("../../pages/layout.tsx", import.meta.url), "utf8")

describe("global sync client action provenance wiring", () => {
  test("tags global config updates with client action headers", () => {
    expect(globalSyncSource).toContain("clientActionHeaders")
    expect(globalSyncSource).toContain('kind: "global.config.update"')
    expect(globalSyncSource).toContain("actionClient.global.config")
    expect(globalSyncSource).toContain(".update({ config })")
  })

  test("tags provider disconnect lifecycle dispose calls with client action headers", () => {
    expect(settingsProvidersSource).toContain("clientActionHeaders")
    expect(settingsProvidersSource).toContain('kind: "settings.provider.disconnect"')
    expect(settingsProvidersSource).toContain("actionClient.global.dispose")
    expect(settingsProvidersSource).toContain("provider.disconnect.toast.disconnected.deferredDescription")
  })

  test("tags workspace reset instance disposal with client action headers", () => {
    expect(layoutSource).toContain("clientActionHeaders")
    expect(layoutSource).toContain('kind: "workspace.reset"')
    expect(layoutSource).toContain("actionClient.instance.dispose")
  })
})
