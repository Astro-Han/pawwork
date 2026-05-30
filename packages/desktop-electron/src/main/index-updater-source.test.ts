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
    const earlyReturnIndex = source.search(/if\s*\(\s*!UPDATER_ACTIVE\s*\)\s*return/)
    const listenerIndex = source.search(/autoUpdater\.on\("download-progress"/)
    expect(earlyReturnIndex).toBeGreaterThan(0)
    expect(listenerIndex).toBeGreaterThan(earlyReturnIndex)
  })

  test("reapplies current progress to a new window on ready-to-show", () => {
    expect(source).toContain('win.once("ready-to-show"')
    const hookIndex = source.search(/win\.once\("ready-to-show"/)
    const reapplySlice = source.slice(hookIndex, hookIndex + 400)
    expect(reapplySlice).toMatch(/if\s*\(\s*currentProgress\s*!==\s*null\s*\)/)
    expect(reapplySlice).toMatch(/win\.setProgressBar\(currentProgress\)/)
  })

  test("failure dialog uses reason-specific copy and three recovery buttons", () => {
    expect(source).toContain("labels.failed.reasonCopy[result.reason]")
    expect(source).toContain("labels.failed.currentVersionUnaffected")
    expect(source).toMatch(/\[result\.message,\s*labels\.failed\.currentVersionUnaffected\]/)
    expect(source).toContain(
      "[labels.failed.buttons.retry, labels.failed.buttons.openDownloadPage, labels.failed.buttons.later]",
    )
    expect(source).toContain("defaultId: 0")
    expect(source).toContain("cancelId: 2")
  })

  test("failure dialog retry awaits recursion and logs rejection", () => {
    expect(source).toMatch(
      /try\s*\{\s*await\s+checkForUpdates\(alertOnFail\)\s*\}\s*catch\s*\(error\)\s*\{\s*logger\.error\("retry after update failure failed"/,
    )
  })

  test("failure dialog open-download-page opens the releases URL", () => {
    expect(source).toMatch(/const LATEST_RELEASE_URL = "https:\/\/github\.com\/Astro-Han\/pawwork\/releases\/latest"/)
    expect(source).toMatch(/shell\.openExternal\(LATEST_RELEASE_URL\)/)
  })

  test("install-failure dialog uses the unified structure without a retry button", () => {
    expect(source).toContain("labels.failed.installFailedMessage")
    expect(source).toContain(
      "[labels.failed.buttons.openDownloadPage, labels.failed.buttons.later]",
    )
    const installBlockStart = source.search(/catch\s*\(\s*error\s*\)\s*\{\s*logger\.error\("install update failed"/)
    expect(installBlockStart).toBeGreaterThan(0)
    const installSlice = source.slice(installBlockStart, installBlockStart + 800)
    expect(installSlice).toContain("labels.failed.installFailedMessage")
    expect(installSlice).toContain("labels.failed.currentVersionUnaffected")
    expect(installSlice).not.toContain("labels.failed.buttons.retry")
  })
})
