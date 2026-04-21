import { describe, expect, test } from "bun:test"
import { createUpdaterController } from "./updater"

function controller(overrides: Partial<Parameters<typeof createUpdaterController>[0]> = {}) {
  const calls = {
    check: 0,
    download: 0,
    install: 0,
  }
  const deps = {
    enabled: true,
    currentVersion: () => "0.2.4",
    checkForUpdates: async () => {
      calls.check += 1
      return { isUpdateAvailable: false, updateInfo: { version: "0.2.4", files: [] } }
    },
    downloadUpdate: async () => {
      calls.download += 1
    },
    quitAndInstall: () => {
      calls.install += 1
    },
    log: () => undefined,
    error: () => undefined,
    ...overrides,
  }

  return {
    calls,
    updater: createUpdaterController(deps),
  }
}

describe("updater controller", () => {
  test("reports disabled when updater is gated off", async () => {
    const setup = controller({ enabled: false })
    await expect(setup.updater.check()).resolves.toEqual({ status: "disabled" })
    expect(setup.calls.check).toBe(0)
    expect(setup.calls.download).toBe(0)
    expect(setup.calls.install).toBe(0)
  })

  test("reports no update", async () => {
    const setup = controller()
    await expect(setup.updater.check()).resolves.toEqual({ status: "none" })
    expect(setup.calls.check).toBe(1)
  })

  test("treats inactive updater result as no update", async () => {
    const setup = controller({ checkForUpdates: async () => null })
    await expect(setup.updater.check()).resolves.toEqual({ status: "none" })
  })

  test("downloads available update", async () => {
    const setup = controller({
      checkForUpdates: async () => ({
        isUpdateAvailable: true,
        updateInfo: { version: "0.2.5", files: [{ url: "app.zip" }] },
      }),
    })
    await expect(setup.updater.check()).resolves.toEqual({ status: "ready", version: "0.2.5" })
    expect(setup.calls.download).toBe(1)
  })

  test("keeps a downloaded update ready until install starts", async () => {
    const setup = controller({
      checkForUpdates: async () => {
        setup.calls.check += 1
        if (setup.calls.check === 1) {
          return { isUpdateAvailable: true, updateInfo: { version: "0.2.5", files: [{ url: "app.zip" }] } }
        }
        return { isUpdateAvailable: false, updateInfo: { version: "0.2.4", files: [] } }
      },
    })

    await expect(setup.updater.check()).resolves.toEqual({ status: "ready", version: "0.2.5" })
    await expect(setup.updater.check()).resolves.toEqual({ status: "ready", version: "0.2.5" })
    expect(setup.updater.install()).toBe(true)
    expect(setup.calls.install).toBe(1)
    expect(setup.updater.install()).toBe(false)
  })

  test("keeps a ready update if install throws before starting", async () => {
    const setup = controller({
      checkForUpdates: async () => ({
        isUpdateAvailable: true,
        updateInfo: { version: "0.2.5", files: [{ url: "app.zip" }] },
      }),
      quitAndInstall: () => {
        throw new Error("install failed")
      },
    })

    await expect(setup.updater.check()).resolves.toEqual({ status: "ready", version: "0.2.5" })
    expect(() => setup.updater.install()).toThrow("install failed")
    await expect(setup.updater.check()).resolves.toEqual({ status: "ready", version: "0.2.5" })
  })

  test("can dismiss a ready update before checking again", async () => {
    const setup = controller({
      checkForUpdates: async () => {
        setup.calls.check += 1
        if (setup.calls.check === 1) {
          return { isUpdateAvailable: true, updateInfo: { version: "0.2.5", files: [{ url: "app.zip" }] } }
        }
        return { isUpdateAvailable: false, updateInfo: { version: "0.2.4", files: [] } }
      },
    })

    await expect(setup.updater.check()).resolves.toEqual({ status: "ready", version: "0.2.5" })
    expect(setup.updater.dismissReady()).toBe(true)
    await expect(setup.updater.check()).resolves.toEqual({ status: "none" })
    expect(setup.calls.check).toBe(2)
  })

  test("reports busy during inflight check", async () => {
    let release: (() => void) | undefined
    const setup = controller({
      checkForUpdates: () => {
        setup.calls.check += 1
        return new Promise((resolve) => {
          release = () => resolve({ isUpdateAvailable: false, updateInfo: { version: "0.2.4", files: [] } })
        })
      },
    })
    const first = setup.updater.check()
    const second = setup.updater.check()
    await expect(second).resolves.toEqual({ status: "busy" })
    release!()
    await expect(first).resolves.toEqual({ status: "none" })
    expect(setup.calls.check).toBe(1)
  })

  test("reports check failure when update check throws", async () => {
    const setup = controller({
      checkForUpdates: async () => {
        throw new Error("network error")
      },
    })

    await expect(setup.updater.check()).resolves.toEqual({
      status: "failed",
      reason: "check",
      message: "network error",
    })
  })

  test("reports metadata failure when version is missing", async () => {
    const setup = controller({
      checkForUpdates: async () => ({
        isUpdateAvailable: true,
        updateInfo: { files: [{ url: "app.zip" }] },
      }),
    })

    await expect(setup.updater.check()).resolves.toEqual({
      status: "failed",
      reason: "metadata",
      message: "Update metadata has no version",
    })
  })

  test("reports metadata failure when files are missing", async () => {
    const setup = controller({
      checkForUpdates: async () => ({
        isUpdateAvailable: true,
        updateInfo: { version: "0.2.5", files: [] },
      }),
    })

    await expect(setup.updater.check()).resolves.toEqual({
      status: "failed",
      reason: "metadata",
      message: "Update metadata has no files",
    })
  })

  test("distinguishes download failure", async () => {
    const setup = controller({
      checkForUpdates: async () => ({
        isUpdateAvailable: true,
        updateInfo: { version: "0.2.5", files: [{ url: "app.zip" }] },
      }),
      downloadUpdate: async () => {
        throw new Error("download failed")
      },
    })
    await expect(setup.updater.check()).resolves.toEqual({
      status: "failed",
      reason: "download",
      message: "download failed",
    })
  })
})
