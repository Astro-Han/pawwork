import { homedir as currentHomedir } from "node:os"
import path from "node:path"
import { UPDATER_CACHE_DIR_NAME } from "./app-identity"

type CacheInput = {
  platform?: NodeJS.Platform
  homedir?: string
  env?: NodeJS.ProcessEnv
}

function pathForPlatform(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix
}

function firstAbsolutePath(
  platformPath: typeof path.posix | typeof path.win32,
  fallback: string,
  ...values: Array<string | undefined>
) {
  return values.find((value) => value && platformPath.isAbsolute(value)) ?? fallback
}

export function pendingUpdateCacheDir(input: CacheInput = {}) {
  const platform = input.platform ?? process.platform
  const homedir = input.homedir ?? currentHomedir()
  const env = input.env ?? process.env
  const platformPath = pathForPlatform(platform)

  const cacheRoot = platform === "win32"
    ? firstAbsolutePath(
      platformPath,
      platformPath.join(homedir, "AppData", "Local"),
      env.LOCALAPPDATA,
      env.localappdata,
    )
    : platformPath.join(homedir, "Library", "Caches")
  return platformPath.join(cacheRoot, UPDATER_CACHE_DIR_NAME, "pending")
}
