const RECOVERABLE_NETWORK_MARKERS = ["err_network_io_suspended", "err_connection_closed"]
type RecoverableSseDisconnectKind = "abort" | "network"

function errorName(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
    ? error.name
    : undefined
}

function errorMessage(error: unknown) {
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : undefined
}

function recoverableSseDisconnectKind(error: unknown): RecoverableSseDisconnectKind | undefined {
  const name = errorName(error)
  if (name === "AbortError") return "abort"

  const message = errorMessage(error)?.trim().toLowerCase()
  if (!message) return
  if (name === "TypeError" && message === "network error") return "network"
  if (RECOVERABLE_NETWORK_MARKERS.some((marker) => message.includes(marker))) return "network"
}

export function isRecoverableSseDisconnect(error: unknown) {
  return recoverableSseDisconnectKind(error) !== undefined
}

export function createRecoverableSseDisconnectReporter(options: { reportAfter: number }) {
  const reportAfter = Math.max(1, options.reportAfter)
  let networkDisconnects = 0
  let reported = false

  return {
    reset() {
      networkDisconnects = 0
      reported = false
    },
    shouldReport(error: unknown) {
      const kind = recoverableSseDisconnectKind(error)
      if (kind === undefined) return true
      if (kind === "abort") return false

      networkDisconnects += 1
      if (reported || networkDisconnects < reportAfter) return false

      reported = true
      return true
    },
  }
}
