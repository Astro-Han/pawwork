import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"
import { writeAppUpdateConfig, type GitHubPublishConfig } from "./scripts/write-app-update-config"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
type Channel = "dev" | "beta" | "prod"
const localizedMacDisplayNameByChannel: Record<Channel, string> = {
  dev: "爪印 Dev",
  beta: "爪印 Beta",
  prod: "爪印",
}

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

function currentChannel(): Channel {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}

export function getPublishConfig(channel: Channel): GitHubPublishConfig | undefined {
  if (channel === "beta") return { provider: "github", owner: "Astro-Han", repo: "pawwork-beta", channel: "latest" }
  if (channel === "prod") return { provider: "github", owner: "Astro-Han", repo: "pawwork", channel: "latest" }
  return undefined
}

async function writeLocalizedMacDisplayName(resourcesDir: string, channel: Channel) {
  const name = localizedMacDisplayNameByChannel[channel]
  const content = [`CFBundleDisplayName = "${name}";`, `CFBundleName = "${name}";`, ""].join("\n")

  for (const locale of ["zh-Hans.lproj", "zh_CN.lproj"]) {
    const dir = path.join(resourcesDir, locale)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "InfoPlist.strings"), content, "utf8")
  }
}

const getBase = (): Configuration => ({
  artifactName: "pawwork-${os}-${arch}-${version}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: path.join(rootDir, "skills"),
      to: "skills",
      filter: ["**/*"],
    },
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
    {
      from: "resources/tools/",
      to: "tools/",
      filter: ["**/*"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    extendInfo: {
      LSHasLocalizedDisplayName: true,
    },
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "PawWork",
    schemes: ["pawwork"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: [{ target: "nsis", arch: ["x64"] }],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
})

export function createConfig(channel: Channel = currentChannel(), baseOverrides: Partial<Configuration> = {}) {
  const base = { ...getBase(), ...baseOverrides }
  const publish = getPublishConfig(channel)

  const withAppUpdateConfig = (configuration: Configuration): Configuration => ({
    ...configuration,
    publish,
    afterPack: async (context) => {
      if (typeof configuration.afterPack === "function") {
        await configuration.afterPack(context)
      }
      if (context.electronPlatformName !== "darwin") return
      const resourcesDir = context.packager.getMacOsResourcesDir(context.appOutDir)
      await writeLocalizedMacDisplayName(resourcesDir, channel)
      if (publish === undefined) return
      await writeAppUpdateConfig(resourcesDir, publish)
    },
  })

  switch (channel) {
    case "dev": {
      return withAppUpdateConfig({
        ...base,
        appId: "ai.pawwork.desktop.dev",
        productName: "PawWork Dev",
        rpm: { packageName: "pawwork-dev" },
      })
    }
    case "beta": {
      return withAppUpdateConfig({
        ...base,
        appId: "ai.pawwork.desktop.beta",
        productName: "PawWork Beta",
        protocols: { name: "PawWork Beta", schemes: ["pawwork"] },
        rpm: { packageName: "pawwork-beta" },
      })
    }
    case "prod": {
      return withAppUpdateConfig({
        ...base,
        appId: "ai.pawwork.desktop",
        productName: "PawWork",
        protocols: { name: "PawWork", schemes: ["pawwork"] },
        rpm: { packageName: "pawwork" },
      })
    }
  }
}

export default createConfig()
