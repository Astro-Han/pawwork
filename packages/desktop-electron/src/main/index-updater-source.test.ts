import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

describe("main updater source contracts", () => {
  test("disables stable downgrades after assigning latest channel", () => {
    const channelIndex = source.search(/autoUpdater\.channel\s*=\s*"latest"/)
    const downgradeIndex = source.search(/autoUpdater\.allowDowngrade\s*=\s*false/)
    expect(channelIndex).toBeGreaterThanOrEqual(0)
    expect(downgradeIndex).toBeGreaterThan(channelIndex)
    expect(source).not.toContain("autoUpdater.allowDowngrade = true")
  })

  test("disables auto install on quit only on macOS", () => {
    expect(source).toContain('autoUpdater.autoInstallOnAppQuit = process.platform !== "darwin"')
    expect(source).not.toContain("autoUpdater.autoInstallOnAppQuit = false")
  })

  test("strict pending cleanup uses shared updater cache helper and propagates rm errors", () => {
    expect(source).toContain('import { pendingUpdateCacheDir } from "./updater-cache"')
    expect(source).toContain("await rm(pendingUpdateCacheDir(), { recursive: true, force: true })")
    expect(source).not.toMatch(
      /rm\(pendingUpdateCacheDir\(\),\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)\s*\.catch\(\(\)\s*=>/,
    )
  })
})
