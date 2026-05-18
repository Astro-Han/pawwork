const RECOVERABLE_NETWORK_MARKERS = ["err_network_io_suspended", "err_connection_closed"]

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

export function isRecoverableSseDisconnect(error: unknown) {
  const name = errorName(error)
  if (name === "AbortError") return true

  const message = errorMessage(error)?.trim().toLowerCase()
  if (!message) return false
  if (name === "TypeError" && message === "network error") return true
  return RECOVERABLE_NETWORK_MARKERS.some((marker) => message.includes(marker))
}
