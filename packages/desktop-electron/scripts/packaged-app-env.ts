import { PAWWORK_APP, PAWWORK_RELEASE_OWNER, isPawWorkChannel, type PawWorkChannel } from "../src/main/app-identity.ts"

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

// dev publishes nowhere, so it has no draft to file and no app-update.yml to
// verify; an empty repo is how the workflow reads "nothing to check", and the
// steps that would use it are gated on the channel anyway.
function publishEnv(channel: PawWorkChannel) {
  const repo = PAWWORK_APP[channel].releaseRepo
  return { PUBLISH_OWNER: repo ? PAWWORK_RELEASE_OWNER : "", PUBLISH_REPO: repo ?? "" }
}

// The arch is passed explicitly so CI resolves the directory electron-builder
// was told to write, not the one the runner happens to be.
if (import.meta.main) {
  const [channel, arch = process.arch] = process.argv.slice(2)
  if (!isPawWorkChannel(channel)) throw new Error(`Unsupported channel: ${channel}`)
  const values = { ...packagedAppEnv(channel, process.platform, arch), ...publishEnv(channel) }
  for (const [key, value] of Object.entries(values)) {
    console.log(`${key}=${value}`)
  }
}
