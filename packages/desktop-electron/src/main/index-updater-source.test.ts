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

  test("broadcasts download progress to every open window", () => {
    expect(source).toContain('autoUpdater.on("download-progress"')
    expect(source).toMatch(/currentProgress\s*=\s*info\.percent\s*\/\s*100/)
    expect(source).toMatch(/for\s*\(\s*const\s+win\s+of\s+BrowserWindow\.getAllWindows\(\)\s*\)/)
    expect(source).toContain("win.setProgressBar(")
  })

  test("clears the progress bar on every updater terminal event", () => {
    expect(source).toContain('autoUpdater.on("update-downloaded", clearProgressBar)')
    expect(source).toContain('autoUpdater.on("update-not-available", clearProgressBar)')
    expect(source).toContain('autoUpdater.on("update-cancelled", clearProgressBar)')
    expect(source).toContain('autoUpdater.on("error"')
    expect(source).toContain('logger.error("updater error"')
  })

  test("registers progress listeners only after the updater-disabled early return", () => {
    const earlyReturnIndex = source.search(/if\s*\(\s*!UPDATER_ENABLED\s*\)\s*return/)
    const listenerIndex = source.search(/autoUpdater\.on\("download-progress"/)
    expect(earlyReturnIndex).toBeGreaterThan(0)
    expect(listenerIndex).toBeGreaterThan(earlyReturnIndex)
  })
})
