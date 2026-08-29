import { gt, parse } from "semver"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Every reason needs dialog copy in every locale, so the set is stated once and
// updater-dialog-labels is typed against it.
export type UpdateFailureReason = "check" | "download" | "metadata" | "cache"

// The renderer-observable projection of the controller. `idle` is pre-first-check;
// `none` is a settled check that found nothing newer. Unlike UpdateResult there is
// no `busy`: a second check during an in-flight one leaves the observed state on the
// in-flight phase, which already says what the UI needs.
export type UpdaterState =
  | { status: "idle" }
  | { status: "disabled" }
  | { status: "checking" }
  | { status: "downloading"; version: string }
  | { status: "none" }
  | { status: "ready"; version: string }
  | { status: "failed"; reason: UpdateFailureReason; message: string }

export type UpdateResult =
  | { status: "disabled" }
  | { status: "none" }
  | { status: "busy" }
  | { status: "ready"; version: string }
  | { status: "failed"; reason: UpdateFailureReason; message: string }

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
  let readyVersion: string | undefined
  let state: UpdaterState = deps.enabled ? { status: "idle" } : { status: "disabled" }
  const listeners = new Set<() => void>()

  const setState = (next: UpdaterState) => {
    state = next
    for (const listener of listeners) listener()
  }

  const fail = (reason: UpdateFailureReason, message: string): UpdateResult => {
    setState({ status: "failed", reason, message })
    return { status: "failed", reason, message }
  }
  const none = (): UpdateResult => {
    setState({ status: "none" })
    return { status: "none" }
  }

  const run = async (): Promise<UpdateResult> => {
    if (!deps.enabled) return { status: "disabled" }
    const currentVersion = deps.currentVersion()
    if (readyVersion !== undefined) {
      const comparison = newerThanCurrent(readyVersion, currentVersion)
      if (comparison === "invalid") {
        return fail("metadata", "Update version is invalid")
      }
      if (comparison) {
        deps.log("update already downloaded", { releaseVersion: readyVersion })
        return { status: "ready", version: readyVersion }
      }
      try {
        await deps.clearPendingUpdate()
      } catch (error) {
        deps.error("stale update cache cleanup failed", error)
        return fail("cache", errorMessage(error))
      }
      readyVersion = undefined
    }
    let clearedStalePendingMetadata = false

    setState({ status: "checking" })
    while (true) {
      deps.log("checking for updates", { currentVersion })

      let result: Awaited<ReturnType<Deps["checkForUpdates"]>>
      try {
        result = await deps.checkForUpdates()
      } catch (error) {
        deps.error("update check failed", error)
        if (isInvalidVersionError(error)) {
          return fail("metadata", errorMessage(error))
        }
        return fail("check", errorMessage(error))
      }

      if (!result) return none()

      const info = result.updateInfo
      deps.log("update metadata fetched", {
        releaseVersion: info?.version ?? null,
        files: info?.files?.map((file) => file.url) ?? [],
      })

      if (!result.isUpdateAvailable) return none()
      if (!info?.version) return fail("metadata", "Update metadata has no version")
      if (!info.files || info.files.length === 0) {
        return fail("metadata", "Update metadata has no files")
      }
      const comparison = newerThanCurrent(info.version, currentVersion)
      if (comparison === "invalid") {
        return fail("metadata", "Update version is invalid")
      }
      if (!comparison) {
        if (clearedStalePendingMetadata) return none()
        try {
          await deps.clearPendingUpdate()
        } catch (error) {
          deps.error("stale update cache cleanup failed", error)
          return fail("cache", errorMessage(error))
        }
        clearedStalePendingMetadata = true
        continue
      }

      setState({ status: "downloading", version: info.version })
      try {
        await deps.downloadUpdate()
      } catch (error) {
        deps.error("update download failed", error)
        return fail("download", errorMessage(error))
      }

      readyVersion = info.version
      setState({ status: "ready", version: info.version })
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
      if (readyVersion === undefined) return false
      const currentVersion = deps.currentVersion()
      const comparison = newerThanCurrent(readyVersion, currentVersion)
      if (comparison !== true) {
        deps.log("stale ready update install skipped", { releaseVersion: readyVersion, currentVersion })
        return false
      }
      // Keep the ready latch if quitAndInstall throws before Electron starts installing.
      deps.quitAndInstall()
      readyVersion = undefined
      return true
    },
    dismissReady() {
      if (readyVersion === undefined) return false
      readyVersion = undefined
      deps.log("dismissed ready update")
      return true
    },
    getState() {
      return state
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
