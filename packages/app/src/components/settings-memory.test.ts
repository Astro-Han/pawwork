import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("memory settings source contract", () => {
  test("registers the Memory settings tab", () => {
    // settings-shell.tsx replaces the old settings-page.tsx as where tabs are registered; read the new
    // shell, otherwise this asserts against deleted dead code.
    const shell = readFileSync("src/pages/settings/settings-shell.tsx", "utf8")

    expect(shell).toContain('"memory"')
    expect(shell).toContain("SettingsMemory")
    expect(shell).toContain("settings.tab.memory")
  })

  test("keeps the v1 raw controls", () => {
    const settings = readFileSync("src/components/settings-memory.tsx", "utf8")

    expect(settings).toContain("settings-memory-raw")
    expect(settings).toContain("memory.disabled")
    expect(settings).not.toContain("settings-memory-delete-id")
  })
})
