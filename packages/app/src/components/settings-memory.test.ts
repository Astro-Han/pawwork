import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("memory settings source contract", () => {
  test("registers the Memory settings tab", () => {
    const page = readFileSync("src/components/settings-page.tsx", "utf8")

    expect(page).toContain('"memory"')
    expect(page).toContain("SettingsMemory")
    expect(page).toContain("settings.tab.memory")
  })

  test("keeps the v1 raw controls", () => {
    const settings = readFileSync("src/components/settings-memory.tsx", "utf8")

    expect(settings).toContain("settings-memory-raw")
    expect(settings).toContain("memory.disabled")
    expect(settings).toContain("deleteEntry")
  })
})

