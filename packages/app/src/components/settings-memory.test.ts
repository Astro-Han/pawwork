import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("memory settings source contract", () => {
  test("registers the Memory settings tab", () => {
    // 新壳 settings-shell.tsx 取代旧 settings-page.tsx 注册各 tab；读新壳否则测的是已删的死代码。
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
