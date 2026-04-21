import { errorMessage } from "./error"

export type UpdateResult =
  | { status: "disabled" }
  | { status: "none" }
  | { status: "busy" }
  | { status: "ready"; version: string }
  | { status: "failed"; reason: "check" | "download" | "metadata"; message: string }

type UpdateInfo = {
  version?: string
  files?: Array<{ url: string }>
}

type Deps = {
  enabled: boolean
  currentVersion: () => string
  checkForUpdates: () => Promise<{ isUpdateAvailable: boolean; updateInfo?: UpdateInfo } | null>
  downloadUpdate: () => Promise<unknown>
  quitAndInstall: () => void
  log: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, error: unknown) => void
}

export function createUpdaterController(deps: Deps) {
  let inflight: Promise<UpdateResult> | undefined
  let updateReady = false
  let readyVersion: string | undefined

  const run = async (): Promise<UpdateResult> => {
    if (!deps.enabled) return { status: "disabled" }
    if (updateReady && readyVersion !== undefined) {
      deps.log("update already downloaded", { releaseVersion: readyVersion })
      return { status: "ready", version: readyVersion }
    }
    deps.log("checking for updates", { currentVersion: deps.currentVersion() })

    let result: Awaited<ReturnType<Deps["checkForUpdates"]>>
    try {
      result = await deps.checkForUpdates()
    } catch (error) {
      deps.error("update check failed", error)
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
