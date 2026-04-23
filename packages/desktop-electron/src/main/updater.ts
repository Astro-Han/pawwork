import { gt, parse } from "semver"

import { errorMessage } from "./error"

export type UpdateResult =
  | { status: "disabled" }
  | { status: "none" }
  | { status: "busy" }
  | { status: "ready"; version: string }
  | { status: "failed"; reason: "check" | "download" | "metadata" | "cache"; message: string }

type UpdateInfo = {
  version?: string
  files?: Array<{ url: string }>
}

type Deps = {
  enabled: boolean
  currentVersion: () => string
  checkForUpdates: () => Promise<{ isUpdateAvailable: boolean; updateInfo?: UpdateInfo } | null>
  downloadUpdate: () => Promise<unknown>
  clearPendingUpdate: () => Promise<void>
  quitAndInstall: () => void
  log: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, error: unknown) => void
}

function isInvalidVersionError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ERR_UPDATER_INVALID_VERSION"
}

function newerThanCurrent(version: string, currentVersion: string) {
  const parsedVersion = parse(version)
  const parsedCurrent = parse(currentVersion)
  if (!parsedVersion || !parsedCurrent) return "invalid"
  return gt(parsedVersion, parsedCurrent)
}

export function createUpdaterController(deps: Deps) {
  let inflight: Promise<UpdateResult> | undefined
  let updateReady = false
  let readyVersion: string | undefined

  const run = async (): Promise<UpdateResult> => {
    if (!deps.enabled) return { status: "disabled" }
    const currentVersion = deps.currentVersion()
    if (updateReady && readyVersion !== undefined) {
      const comparison = newerThanCurrent(readyVersion, currentVersion)
      if (comparison === "invalid") {
        return { status: "failed", reason: "metadata", message: "Update version is invalid" }
      }
      if (comparison) {
        deps.log("update already downloaded", { releaseVersion: readyVersion })
        return { status: "ready", version: readyVersion }
      }
      try {
        await deps.clearPendingUpdate()
      } catch (error) {
        deps.error("stale update cache cleanup failed", error)
        return { status: "failed", reason: "cache", message: errorMessage(error) }
      }
      updateReady = false
      readyVersion = undefined
    }
    let clearedStalePendingMetadata = false

    while (true) {
      deps.log("checking for updates", { currentVersion })

      let result: Awaited<ReturnType<Deps["checkForUpdates"]>>
      try {
        result = await deps.checkForUpdates()
      } catch (error) {
        deps.error("update check failed", error)
        if (isInvalidVersionError(error)) {
          return { status: "failed", reason: "metadata", message: errorMessage(error) }
        }
        return { status: "failed", reason: "check", message: errorMessage(error) }
      }

      if (!result) return { status: "none" }

      const info = result.updateInfo
      deps.log("update metadata fetched", {
        releaseVersion: info?.version ?? null,
        files: info?.files?.map((file) => file.url) ?? [],
      })

      if (!result.isUpdateAvailable) return { status: "none" }
      if (!info?.version) return { status: "failed", reason: "metadata", message: "Update metadata has no version" }
      if (!info.files || info.files.length === 0) {
        return { status: "failed", reason: "metadata", message: "Update metadata has no files" }
      }
      const comparison = newerThanCurrent(info.version, currentVersion)
      if (comparison === "invalid") {
        return { status: "failed", reason: "metadata", message: "Update version is invalid" }
      }
      if (!comparison) {
        if (clearedStalePendingMetadata) return { status: "none" }
        try {
          await deps.clearPendingUpdate()
        } catch (error) {
          deps.error("stale update cache cleanup failed", error)
          return { status: "failed", reason: "cache", message: errorMessage(error) }
        }
        clearedStalePendingMetadata = true
        continue
      }

      try {
        await deps.downloadUpdate()
      } catch (error) {
        deps.error("update download failed", error)
        return { status: "failed", reason: "download", message: errorMessage(error) }
      }

      updateReady = true
      readyVersion = info.version
      return { status: "ready", version: info.version }
    }
  }

  return {
    check() {
      if (inflight) return Promise.resolve({ status: "busy" as const })
      inflight = run().finally(() => {
        inflight = undefined
      })
      return inflight
    },
    install() {
      if (!updateReady || readyVersion === undefined) return false
      const currentVersion = deps.currentVersion()
      const comparison = newerThanCurrent(readyVersion, currentVersion)
      if (comparison !== true) {
        deps.log("stale ready update install skipped", { releaseVersion: readyVersion, currentVersion })
        return false
      }
      // Keep the ready latch if quitAndInstall throws before Electron starts installing.
      deps.quitAndInstall()
      updateReady = false
      readyVersion = undefined
      return true
    },
    dismissReady() {
      if (!updateReady) return false
      updateReady = false
      readyVersion = undefined
      deps.log("dismissed ready update")
      return true
    },
    busy() {
      return Boolean(inflight)
    },
  }
}
