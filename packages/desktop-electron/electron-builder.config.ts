import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"
import { PAWWORK_APP, PAWWORK_PACKAGE_NAME, PAWWORK_RELEASE_OWNER, type PawWorkChannel, localizedPawWorkName, parsePawWorkChannel } from "./src/main/app-identity"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
type GitHubPublishConfig = {
  provider: "github"
  owner: string
  repo: string
  channel: string
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

export function getPublishConfig(channel: PawWorkChannel): GitHubPublishConfig | undefined {
  const repo = PAWWORK_APP[channel].releaseRepo
  if (!repo) return undefined
  return { provider: "github", owner: PAWWORK_RELEASE_OWNER, repo, channel: "latest" }
}

async function writeLocalizedMacDisplayName(resourcesDir: string, channel: PawWorkChannel) {
  const name = localizedPawWorkName(PAWWORK_APP[channel].name)
  const content = [`CFBundleDisplayName = "${name}";`, `CFBundleName = "${name}";`, ""].join("\n")

  for (const locale of ["zh-Hans.lproj", "zh_CN.lproj"]) {
    const dir = path.join(resourcesDir, locale)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "InfoPlist.strings"), content, "utf8")
  }
}

const repositoryUrl = (channel: PawWorkChannel) => `https://github.com/Astro-Han/${getPublishConfig(channel)?.repo ?? "pawwork"}`

const getBase = (channel: PawWorkChannel): Configuration => ({
  artifactName: "pawwork-${os}-${arch}-${version}.${ext}",
  // DSH maintains real symlinks from its user profile to the installed
  // dependency closure. Keep dependencies outside the virtual ASAR filesystem
  // so those links remain traversable in packaged builds.
  asarUnpack: ["node_modules/**/*"],
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/main/**/*", "resources/**/*", "!resources/dsh/**/*"],
  // electron-builder reads .git/config for repository info, which fails on
  // CI runners with persist-credentials: false. Set explicitly via
  // extraMetadata to avoid "Cannot detect repository by .git/config".
  extraMetadata: {
    // The packaged package name is what electron-builder turns into the updater
    // cache directory (see PAWWORK_PACKAGE_NAME). userData and the app name are
    // set explicitly at startup, so the app itself never reads it — but NSIS
    // does: APP_PACKAGE_NAME comes from here and the uninstaller's
    // `--delete-app-data` does RMDir /r "$APPDATA\<name>". Keep nothing of ours
    // under %APPDATA%\pawwork.
    name: PAWWORK_PACKAGE_NAME,
    repository: { type: "git", url: repositoryUrl(channel) },
  },
  extraResources: [
    {
      from: "resources/dsh/",
      to: "dsh/",
      filter: ["**/*", "!**/*.test.cjs"],
    },
    {
      from: "resources/icons/",
      to: "icons",
      filter: ["dock.png", "icon.png", "icon.ico"],
    },
    {
      from: path.join(rootDir, "skills"),
      to: "skills",
      filter: ["**/*"],
    },
    {
      from: path.join(rootDir, "THIRD_PARTY_NOTICES.md"),
      to: "THIRD_PARTY_NOTICES.md",
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
  // Every channel registers the same scheme, so the only per-channel part is the
  // name the OS shows; createConfig used to restate the whole block for beta.
  protocols: {
    name: PAWWORK_APP[channel].name,
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
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    include: "resources/installer.nsh",
    installerLanguages: ["en_US", "zh_CN"],
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
})

export function createConfig(channel: PawWorkChannel = parsePawWorkChannel(process.env.OPENCODE_CHANNEL)): Configuration {
  const identity = PAWWORK_APP[channel]
  return {
    ...getBase(channel),
    appId: identity.id,
    productName: identity.name,
    publish: getPublishConfig(channel),
    // The localized display names live inside the packaged bundle, so they can
    // only be written once it exists.
    afterPack: async (context) => {
      if (context.electronPlatformName !== "darwin") return
      await writeLocalizedMacDisplayName(context.packager.getMacOsResourcesDir(context.appOutDir), channel)
    },
  }
}

export default createConfig()
