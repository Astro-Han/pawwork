import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { Configuration } from "electron-builder"
import { PAWWORK_APP, PAWWORK_PACKAGE_NAME, PAWWORK_RELEASE_OWNER, PAWWORK_UPDATE_CHANNEL, type PawWorkChannel, localizedPawWorkName, parsePawWorkChannel } from "./src/main/app-identity"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
type GitHubPublishConfig = {
  provider: "github"
  owner: string
  repo: string
  channel: string
}
export function getPublishConfig(channel: PawWorkChannel): GitHubPublishConfig | undefined {
  const repo = PAWWORK_APP[channel].releaseRepo
  if (!repo) return undefined
  return { provider: "github", owner: PAWWORK_RELEASE_OWNER, repo, channel: PAWWORK_UPDATE_CHANNEL }
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
  // The DSH dependency closure ships ~20k files, a fifth of which nothing loads
  // at runtime: declaration files and source maps (no source-map-support is
  // installed, so nothing reads them). Dropping them cuts the installed
  // footprint and, more usefully, the file count that signing and notarization
  // have to walk.
  //
  // Documentation is deliberately NOT excluded. Markdown is only ~1.8M here,
  // but the closure uses .md for real payload too — the SKILL.md agent presets
  // under dsh/config/agent-presets and every LICENSE.md we are obliged to ship
  // — so any doc rule has to be maintained against whatever the next DSH
  // release adds. Not worth it for 0.4MB of DMG.
  files: [
    "out/main/**/*",
    "!node_modules/**/*.map",
    "!node_modules/**/*.d.ts",
    "!node_modules/**/*.d.mts",
    "!node_modules/**/*.d.cts",
    // pnpm ships its CLI twice: dist/ and a near-identical copy under
    // artifacts/exe/dist/ that only its own standalone-executable build reads.
    // We invoke bin/pnpm.mjs (see dsh-tools.ts), so the second copy is 14M of
    // nothing.
    "!node_modules/pnpm/artifacts/**/*",
  ],
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
    // Chromium's own native strings (context menus, file dialogs, media
    // controls) — unrelated to anything DSH renders, and PawWork only ships
    // English and Simplified Chinese. electron-builder matches these against
    // the locale file names on disk, which differ per platform: macOS has
    // en.lproj and zh_CN.lproj, Windows has en-US.pak and zh-CN.pak. Using the
    // wrong spelling silently deletes the locale it was meant to keep.
    electronLanguages: ["en", "zh_CN"],
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
  // Dev and packaged builds register the same scheme under their displayed name.
  protocols: {
    name: PAWWORK_APP[channel].name,
    schemes: ["pawwork"],
  },
  win: {
    electronLanguages: ["en-US", "zh-CN"],
    icon: `resources/icons/icon.ico`,
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
