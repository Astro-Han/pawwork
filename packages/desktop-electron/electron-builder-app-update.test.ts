import { afterEach, describe, expect, test } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Configuration } from "electron-builder"
import {
  createConfig,
  getPublishConfig,
} from "./electron-builder.config"

const roots: string[] = []
type AfterPackContext = Parameters<Extract<NonNullable<Configuration["afterPack"]>, (...args: any[]) => unknown>>[0]

function macAfterPackContext(
  appOutDir: string,
  appBundleName: string,
  electronPlatformName = "darwin",
): AfterPackContext {
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
  test("production dependencies contain only DSH and desktop runtime packages", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
    }

    const desktopRuntimePackages = new Set([
      "electron-context-menu",
      "electron-log",
      "electron-updater",
      "electron-window-state",
      "semver",
    ])

    expect(
      Object.keys(manifest.dependencies).filter(
        (dependency) => !dependency.startsWith("@deepseek-ai/") && !desktopRuntimePackages.has(dependency),
      ),
    ).toEqual([])
  })

  test("packages only the DSH production entry", () => {
    const config = createConfig("prod")
    const dshResources = config.extraResources?.find((resource) => typeof resource === "object" && resource.to === "dsh/")

    expect(config.files).toEqual(["out/main/**/*", "resources/**/*", "!resources/dsh/**/*"])
    expect(dshResources).toMatchObject({ filter: ["**/*", "!**/*.test.cjs"] })
    expect(config.extraResources).toEqual([
      expect.objectContaining({ to: "dsh/" }),
      expect.objectContaining({ to: "icons", filter: ["dock.png", "icon.png", "icon.ico"] }),
      expect.objectContaining({ to: "skills" }),
      expect.objectContaining({ to: "THIRD_PARTY_NOTICES.md" }),
      expect.objectContaining({ to: "tools/" }),
    ])
  })

  test("dev does not publish updater config", () => {
    expect(getPublishConfig("dev")).toBeUndefined()
  })

  test("mac packaging enables a localized display name", () => {
    const config = createConfig("prod")
    expect(config.productName).toBe("PawWork")
    expect(config.appId).toBe("ai.pawwork.desktop")
    expect(config.artifactName).toBe("pawwork-${os}-${arch}-${version}.${ext}")
    expect(config.publish).toMatchObject({ owner: "Astro-Han", repo: "pawwork" })
    expect(createConfig("prod").mac?.extendInfo).toMatchObject({
      LSHasLocalizedDisplayName: true,
    })
  })

  test("windows nsis installer uses PawWork shortcut customizations", () => {
    const config = createConfig("prod")

    expect(config.nsis).toMatchObject({
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: false,
      createStartMenuShortcut: true,
      include: "resources/installer.nsh",
      installerLanguages: ["en_US", "zh_CN"],
    })
  })

  test("all channels share the versioned artifact name", () => {
    expect(createConfig("dev").artifactName).toBe("pawwork-${os}-${arch}-${version}.${ext}")
    expect(createConfig("beta").artifactName).toBe("pawwork-${os}-${arch}-${version}.${ext}")
    expect(createConfig("prod").artifactName).toBe("pawwork-${os}-${arch}-${version}.${ext}")
  })

  test("packaged repository metadata follows the release channel", () => {
    expect(createConfig("dev").extraMetadata).toMatchObject({
      repository: { type: "git", url: "https://github.com/Astro-Han/pawwork" },
    })
    expect(createConfig("prod").extraMetadata).toMatchObject({
      repository: { type: "git", url: "https://github.com/Astro-Han/pawwork" },
    })
    expect(createConfig("beta").extraMetadata).toMatchObject({
      repository: { type: "git", url: "https://github.com/Astro-Han/pawwork-beta" },
    })
  })

  test("afterPack writes app-update.yml to the packager-reported macOS resources path", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-builder-config-"))
    roots.push(root)
    const config = createConfig("prod")

    await config.afterPack!(macAfterPackContext(root, "PawWork Product Filename"))

    const configPath = join(root, "PawWork Product Filename.app", "Contents", "Resources", "app-update.yml")
    expect(existsSync(configPath)).toBe(true)
    expect(readFileSync(configPath, "utf8")).toContain("repo: pawwork\n")
    expect(readFileSync(configPath, "utf8")).toContain("updaterCacheDirName: pawwork-updater\n")
  })

  test("afterPack writes localized macOS display names to the final resources path", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-builder-config-"))
    roots.push(root)
    const config = createConfig("prod")

    await config.afterPack!(macAfterPackContext(root, "PawWork"))

    const zhHans = join(root, "PawWork.app", "Contents", "Resources", "zh-Hans.lproj", "InfoPlist.strings")
    const zhCn = join(root, "PawWork.app", "Contents", "Resources", "zh_CN.lproj", "InfoPlist.strings")

    expect(existsSync(zhHans)).toBe(true)
    expect(existsSync(zhCn)).toBe(true)
    expect(readFileSync(zhHans, "utf8")).toContain('CFBundleDisplayName = "爪印";')
    expect(readFileSync(zhHans, "utf8")).toContain('CFBundleName = "爪印";')
    expect(readFileSync(zhCn, "utf8")).toContain('CFBundleDisplayName = "爪印";')
    expect(readFileSync(zhCn, "utf8")).toContain('CFBundleName = "爪印";')
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
