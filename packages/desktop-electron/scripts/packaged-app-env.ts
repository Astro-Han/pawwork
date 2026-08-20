import { PAWWORK_APP, isPawWorkChannel, type PawWorkChannel } from "../src/main/app-identity.ts"

// electron-builder's unpacked output layout is not configurable from our config,
// so it is stated here rather than derived: macOS puts the bundle in a per-arch
// directory, Windows puts the executable in one shared directory.
function outDir(platform: NodeJS.Platform, arch: string) {
  if (platform === "win32") return "dist/win-unpacked"
  if (platform !== "darwin") throw new Error(`Unsupported platform: ${platform}`)
  if (arch === "arm64") return "dist/mac-arm64"
  if (arch === "x64") return "dist/mac"
  throw new Error(`Unsupported arch: ${arch}`)
}

// Where the packaged app lands and what it is called, derived from the same
// tables electron-builder packages from. build.yml restated the channel-to-name
// map seven times, the arch-to-output-directory map six, and the publish target
// once, and the two smoke workflows spelled the full path out by hand: a rename
// in app-identity.ts left every copy pointing at a bundle that no longer
// existed, and nothing said so until the job failed.
export function packagedAppEnv(
  channel: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
) {
  if (!isPawWorkChannel(channel)) throw new Error(`Unsupported channel: ${channel}`)
  const directory = outDir(platform, arch)
  const name = PAWWORK_APP[channel].name
  const appPath = platform === "win32" ? `${directory}/${name}.exe` : `${directory}/${name}.app`
  return {
    APP_NAME: name,
    APP_OUT_DIR: directory,
    APP_PATH: appPath,
    EXECUTABLE_PATH: platform === "win32" ? appPath : `${appPath}/Contents/MacOS/${name}`,
  }
}

// The publish target is a release fact, not a packaging one, and pulling the
// builder config into this module would drag electron-builder into the CI smoke
// harness that imports packagedAppEnv. dev publishes nowhere, so it has no
// app-update.yml to verify; an empty repo is how the workflow reads "nothing to
// check".
async function publishEnv(channel: PawWorkChannel) {
  const { getPublishConfig } = await import("../electron-builder.config.ts")
  const publish = getPublishConfig(channel)
  return { PUBLISH_OWNER: publish?.owner ?? "", PUBLISH_REPO: publish?.repo ?? "" }
}

// The arch is passed explicitly so CI resolves the directory electron-builder
// was told to write, not the one the runner happens to be.
if (import.meta.main) {
  const [channel, arch = process.arch] = process.argv.slice(2)
  if (!isPawWorkChannel(channel)) throw new Error(`Unsupported channel: ${channel}`)
  const values = { ...packagedAppEnv(channel, process.platform, arch), ...(await publishEnv(channel)) }
  for (const [key, value] of Object.entries(values)) {
    console.log(`${key}=${value}`)
  }
}
