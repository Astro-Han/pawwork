import { afterEach, describe, expect, test } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Configuration } from "electron-builder"
import {
  createConfig,
  getPublishConfig,
} from "./electron-builder.config"
import { PAWWORK_PACKAGE_NAME, UPDATER_CACHE_DIR_NAME } from "./src/main/app-identity"

const roots: string[] = []
type AfterPackHook = Extract<NonNullable<Configuration["afterPack"]>, (...args: never[]) => unknown>
type AfterPackContext = Parameters<AfterPackHook>[0]

// electron-builder types afterPack as `string | Hook`; ours is always the hook.
function afterPackHook(config: Configuration): AfterPackHook {
  const hook = config.afterPack
  if (typeof hook !== "function") throw new Error(`afterPack is ${typeof hook}, not a hook`)
  return hook
}

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
  test("packages only the DSH production entry", () => {
    const config = createConfig("prod")
    const extraResources = config.extraResources
    if (!Array.isArray(extraResources)) throw new Error("extraResources must be a list")
    const dshResources = extraResources.find((resource) => typeof resource === "object" && resource.to === "dsh/")

    expect(config.files).toEqual([
      "out/main/**/*",
      "!node_modules/**/*.map",
      "!node_modules/**/*.d.ts",
      "!node_modules/**/*.d.mts",
      "!node_modules/**/*.d.cts",
      "!node_modules/**/README*.md",
      "!node_modules/**/CHANGELOG*.md",
      "!node_modules/**/HISTORY*.md",
      "!node_modules/pnpm/artifacts/**/*",
    ])
    expect(dshResources).toMatchObject({ filter: ["**/*", "!**/*.test.cjs"] })
    expect(config.extraResources).toEqual([
      expect.objectContaining({ to: "dsh/" }),
      expect.objectContaining({ to: "icons", filter: ["dock.png", "icon.png", "icon.ico"] }),
      expect.objectContaining({ to: "skills" }),
      expect.objectContaining({ to: "THIRD_PARTY_NOTICES.md" }),
      expect.objectContaining({ to: "tools/" }),
    ])
  })

  // electron-builder deletes every locale that does not match this list, and it
  // matches against the file names Electron ships: en.lproj / zh_CN.lproj on
  // macOS, en-US.pak / zh-CN.pak on Windows. Spelling both platforms the same
  // way looks tidier and deletes Chinese from one of them.
  test("bundled locales are spelled the way each platform names them", () => {
    const config = createConfig("prod")
    expect(config.mac?.electronLanguages).toEqual(["en", "zh_CN"])
    expect(config.win?.electronLanguages).toEqual(["en-US", "zh-CN"])
    expect(config.electronLanguages).toBeUndefined()
  })

  test("only the production build publishes to the PawWork repository", () => {
    expect(getPublishConfig("dev")).toBeUndefined()
    const prod = getPublishConfig("prod")
    expect(prod).toMatchObject({ provider: "github", owner: "Astro-Han", repo: "pawwork", channel: "latest-v2" })
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

  // One scheme for every channel, named after the channel's app: whichever build
  // installs last owns pawwork:// links, and the OS prompt should say which one.
  test("every channel registers the pawwork scheme under its own name", () => {
    expect(createConfig("dev").protocols).toEqual({ name: "PawWork Dev", schemes: ["pawwork"] })
    expect(createConfig("prod").protocols).toEqual({ name: "PawWork", schemes: ["pawwork"] })
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

  test("Windows packages do not require a signing service", () => {
    expect(createConfig("dev").win?.signtoolOptions).toBeUndefined()
    expect(createConfig("prod").win?.signtoolOptions).toBeUndefined()
  })

  test("packaged repository metadata follows the release channel", () => {
    expect(createConfig("dev").extraMetadata).toMatchObject({
      repository: { type: "git", url: "https://github.com/Astro-Han/pawwork" },
    })
    expect(createConfig("prod").extraMetadata).toMatchObject({
      repository: { type: "git", url: "https://github.com/Astro-Han/pawwork" },
    })
  })


  test("afterPack writes localized macOS display names to the final resources path", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-builder-config-"))
    roots.push(root)
    const config = createConfig("prod")

    await afterPackHook(config)(macAfterPackContext(root, "PawWork"))

    const zhHans = join(root, "PawWork.app", "Contents", "Resources", "zh-Hans.lproj", "InfoPlist.strings")
    const zhCn = join(root, "PawWork.app", "Contents", "Resources", "zh_CN.lproj", "InfoPlist.strings")

    expect(existsSync(zhHans)).toBe(true)
    expect(existsSync(zhCn)).toBe(true)
    expect(readFileSync(zhHans, "utf8")).toContain('CFBundleDisplayName = "爪印";')
    expect(readFileSync(zhHans, "utf8")).toContain('CFBundleName = "爪印";')
    expect(readFileSync(zhCn, "utf8")).toContain('CFBundleDisplayName = "爪印";')
    expect(readFileSync(zhCn, "utf8")).toContain('CFBundleName = "爪印";')
  })


  // electron-builder writes app-update.yml itself on every packaged platform and
  // fills updaterCacheDirName with sanitizeFileName(name).toLowerCase() +
  // "-updater". We cannot call that function from here, so instead of restating
  // its output we pin a package name it cannot change: already lowercase and
  // free of anything sanitize-filename strips, so it passes through unchanged.
  // Drop the extraMetadata name and the app cleans a directory the updater never
  // writes to — which is what "@pawwork/desktop" silently did.
  test("the packaged package name is a fixed point of the updater cache derivation", () => {
    expect(PAWWORK_PACKAGE_NAME).toMatch(/^[a-z0-9][a-z0-9-]*$/)
  })

})
