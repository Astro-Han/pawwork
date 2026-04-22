import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Configuration } from "electron-builder"
import { createConfig, getPublishConfig } from "./electron-builder.config"
import { serializeAppUpdateConfig } from "./scripts/write-app-update-config"

const roots: string[] = []
type AfterPackContext = Parameters<Extract<NonNullable<Configuration["afterPack"]>, (...args: any[]) => unknown>>[0]

function macAfterPackContext(appOutDir: string, appBundleName: string, electronPlatformName = "darwin"): AfterPackContext {
  return {
    appOutDir,
    electronPlatformName,
    packager: {
      getMacOsResourcesDir: (root: string) => join(root, `${appBundleName}.app`, "Contents", "Resources"),
    },
  } as AfterPackContext
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("electron builder app-update config", () => {
  test("prod publish config feeds local updater config", () => {
    expect(serializeAppUpdateConfig(getPublishConfig("prod")!)).toContain("repo: pawwork\n")
  })

  test("beta publish config feeds local updater config", () => {
    expect(serializeAppUpdateConfig(getPublishConfig("beta")!)).toContain("repo: pawwork-beta\n")
  })

  test("dev does not publish updater config", () => {
    expect(getPublishConfig("dev")).toBeUndefined()
  })

  test("mac packaging has an afterPack hook to write app-update.yml before signing", () => {
    expect(typeof createConfig("prod").afterPack).toBe("function")
  })

  test("afterPack writes app-update.yml to the packager-reported macOS resources path", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-builder-config-"))
    roots.push(root)
    const config = createConfig("prod")

    await config.afterPack!(macAfterPackContext(root, "PawWork Product Filename"))

    const configPath = join(root, "PawWork Product Filename.app", "Contents", "Resources", "app-update.yml")
    expect(existsSync(configPath)).toBe(true)
    expect(readFileSync(configPath, "utf8")).toContain("repo: pawwork\n")
  })

  test("afterPack writes beta app-update.yml to the beta app resources path", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-builder-config-"))
    roots.push(root)
    const config = createConfig("beta")

    await config.afterPack!(macAfterPackContext(root, "PawWork Beta"))

    const configPath = join(root, "PawWork Beta.app", "Contents", "Resources", "app-update.yml")
    expect(existsSync(configPath)).toBe(true)
    expect(readFileSync(configPath, "utf8")).toContain("repo: pawwork-beta\n")
  })

  test("afterPack preserves an existing hook before writing updater config", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-builder-config-"))
    roots.push(root)
    const calls: string[] = []
    const config = createConfig("prod", {
      afterPack: async () => {
        calls.push("existing")
      },
    })

    await config.afterPack!(macAfterPackContext(root, "PawWork"))

    const configPath = join(root, "PawWork.app", "Contents", "Resources", "app-update.yml")
    expect(calls).toEqual(["existing"])
    expect(existsSync(configPath)).toBe(true)
  })

  test("afterPack skips updater config when publish is not configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-builder-config-"))
    roots.push(root)
    const config = createConfig("dev")

    await config.afterPack!(macAfterPackContext(root, "PawWork Dev"))

    const configPath = join(root, "PawWork Dev.app", "Contents", "Resources", "app-update.yml")
    expect(existsSync(configPath)).toBe(false)
  })
})
