import { describe, expect, test } from "bun:test"
import { createUpdaterController } from "./updater"

function controller(overrides: Partial<Parameters<typeof createUpdaterController>[0]> = {}) {
  let currentVersion = "0.2.4"
  const calls = {
    check: 0,
    download: 0,
    install: 0,
    clearPending: 0,
  }
  const deps = {
    enabled: true,
    currentVersion: () => currentVersion,
    checkForUpdates: async () => {
      calls.check += 1
      return { isUpdateAvailable: false, updateInfo: { version: "0.2.4", files: [] } }
    },
    downloadUpdate: async () => {
      calls.download += 1
    },
    clearPendingUpdate: async () => {
      calls.clearPending += 1
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
    setCurrentVersion(value: string) {
      currentVersion = value
    },
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

  test("does not download provider downgrade even if provider marks it available", async () => {
    const setup = controller({
      currentVersion: () => "0.2.8",
      checkForUpdates: async () => {
        setup.calls.check += 1
        return { isUpdateAvailable: true, updateInfo: { version: "0.2.7", files: [{ url: "old.zip" }] } }
      },
    })

    await expect(setup.updater.check()).resolves.toEqual({ status: "none" })
    expect(setup.calls.download).toBe(0)
    expect(setup.calls.clearPending).toBe(1)
    expect(setup.calls.check).toBe(2)
  })

  test("clears stale pending metadata once and rechecks for fresh update", async () => {
    const setup = controller({
      currentVersion: () => "0.2.8",
      checkForUpdates: async () => {
        setup.calls.check += 1
        if (setup.calls.check === 1) {
          return { isUpdateAvailable: true, updateInfo: { version: "0.2.7", files: [{ url: "old.zip" }] } }
        }
        return { isUpdateAvailable: true, updateInfo: { version: "0.2.9", files: [{ url: "new.zip" }] } }
      },
    })

    await expect(setup.updater.check()).resolves.toEqual({ status: "ready", version: "0.2.9" })
    expect(setup.calls.clearPending).toBe(1)
    expect(setup.calls.download).toBe(1)
    expect(setup.calls.check).toBe(2)
  })

  test("fails closed when stale pending metadata cleanup fails", async () => {
    const setup = controller({
      currentVersion: () => "0.2.8",
      checkForUpdates: async () => {
        setup.calls.check += 1
        return { isUpdateAvailable: true, updateInfo: { version: "0.2.7", files: [{ url: "old.zip" }] } }
      },
      clearPendingUpdate: async () => {
        setup.calls.clearPending += 1
        throw new Error("permission denied")
      },
    })

    await expect(setup.updater.check()).resolves.toEqual({
      status: "failed",
      reason: "cache",
      message: "permission denied",
    })
    expect(setup.calls.download).toBe(0)
    expect(setup.calls.check).toBe(1)
  })

  test("clears stale ready update before fresh recheck", async () => {
    const setup = controller({
      checkForUpdates: async () => {
        setup.calls.check += 1
        if (setup.calls.check === 1) {
          return { isUpdateAvailable: true, updateInfo: { version: "0.2.9", files: [{ url: "new.zip" }] } }
        }
        return { isUpdateAvailable: false, updateInfo: { version: "0.2.9", files: [] } }
      },
    })

    setup.setCurrentVersion("0.2.8")
    await expect(setup.updater.check()).resolves.toEqual({ status: "ready", version: "0.2.9" })
    setup.setCurrentVersion("0.2.9")
    await expect(setup.updater.check()).resolves.toEqual({ status: "none" })
    expect(setup.calls.clearPending).toBe(1)
    expect(setup.calls.check).toBe(2)
  })

  test("fails closed when stale ready cache cleanup fails", async () => {
    const setup = controller({
      checkForUpdates: async () => {
        setup.calls.check += 1
        return { isUpdateAvailable: true, updateInfo: { version: "0.2.9", files: [{ url: "new.zip" }] } }
      },
      clearPendingUpdate: async () => {
        setup.calls.clearPending += 1
        throw new Error("permission denied")
      },
    })

    setup.setCurrentVersion("0.2.8")
    await expect(setup.updater.check()).resolves.toEqual({ status: "ready", version: "0.2.9" })
    setup.setCurrentVersion("0.2.9")
    await expect(setup.updater.check()).resolves.toEqual({
      status: "failed",
      reason: "cache",
      message: "permission denied",
    })
    await expect(setup.updater.check()).resolves.toEqual({
      status: "failed",
      reason: "cache",
      message: "permission denied",
    })
    expect(setup.calls.clearPending).toBe(2)
    expect(setup.calls.check).toBe(1)
  })

  test("does not install stale ready update if current version catches up", async () => {
    const setup = controller({
      checkForUpdates: async () => {
        setup.calls.check += 1
        return { isUpdateAvailable: true, updateInfo: { version: "0.2.9", files: [{ url: "new.zip" }] } }
      },
    })

    setup.setCurrentVersion("0.2.8")
    await expect(setup.updater.check()).resolves.toEqual({ status: "ready", version: "0.2.9" })
    setup.setCurrentVersion("0.2.9")
    expect(setup.updater.install()).toBe(false)
    expect(setup.calls.install).toBe(0)
  })

  test("keeps semver-newer ready update even when string order would be wrong", async () => {
    const setup = controller({
      currentVersion: () => "0.2.9",
      checkForUpdates: async () => ({
        isUpdateAvailable: true,
        updateInfo: { version: "0.2.10", files: [{ url: "app.zip" }] },
      }),
    })

    await expect(setup.updater.check()).resolves.toEqual({ status: "ready", version: "0.2.10" })
    await expect(setup.updater.check()).resolves.toEqual({ status: "ready", version: "0.2.10" })
    expect(setup.calls.download).toBe(1)
  })

  test("fails metadata when provider update version is invalid", async () => {
    const setup = controller({
      currentVersion: () => "0.2.8",
      checkForUpdates: async () => ({
        isUpdateAvailable: true,
        updateInfo: { version: "not-a-version", files: [{ url: "bad.zip" }] },
      }),
    })

    await expect(setup.updater.check()).resolves.toEqual({
      status: "failed",
      reason: "metadata",
      message: "Update version is invalid",
    })
    expect(setup.calls.download).toBe(0)
  })

  test("maps electron-updater invalid version errors to metadata failure", async () => {
    const error = new Error("invalid semver")
    Object.assign(error, { code: "ERR_UPDATER_INVALID_VERSION" })
    const setup = controller({
      checkForUpdates: async () => {
        throw error
      },
    })

    await expect(setup.updater.check()).resolves.toEqual({
      status: "failed",
      reason: "metadata",
      message: "invalid semver",
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
