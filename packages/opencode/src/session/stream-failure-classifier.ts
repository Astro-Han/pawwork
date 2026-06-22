export type TransportDisconnect = {
  kind: "provider_transport_disconnect"
  retryable: boolean
  code: string
}

// errno / undici codes that mean the connection dropped, timed out, or could
// not be established. All are transient (worth retrying) except the ones in
// NON_RETRYABLE_TRANSPORT_CODES below.
const TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN", // transient DNS lookup failure — retry
  "ENOTFOUND", // permanent DNS failure (see NON_RETRYABLE_TRANSPORT_CODES)
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
])

// ENOTFOUND means the hostname did not resolve — usually a misconfigured base
// URL that will never resolve, so auto-retrying just stalls the turn. Kept
// distinct from EAI_AGAIN (transient DNS), which stays retryable.
const NON_RETRYABLE_TRANSPORT_CODES = new Set(["ENOTFOUND"])

// Connection-dropped signals that can arrive as a bare message with no errno
// code (undici/Node throws these in some paths). Only checked when no code
// matched. "terminated" is intentionally excluded — on its own it is undici's
// generic fetch wrapper and is only a transport failure when its cause carries
// a transport code (handled by the cause walk above).
const TRANSIENT_MESSAGE_CODES: ReadonlyArray<[RegExp, string]> = [
  [/socket hang up/i, "SOCKET_HANG_UP"],
  [/premature close/i, "PREMATURE_CLOSE"],
]

function disconnect(code: string): TransportDisconnect {
  return { kind: "provider_transport_disconnect", retryable: !NON_RETRYABLE_TRANSPORT_CODES.has(code), code }
}

export function classifyStreamFailure(error: unknown): TransportDisconnect | undefined {
  if (!(error instanceof Error)) return undefined

  // An error carrying an HTTP statusCode means an HTTP response was received, so
  // it is an API error classified by status downstream (the APICallError branch
  // in fromError, which runs after this). It must not be reclassified as a
  // transport disconnect — not by a transport-coded cause, and not by a
  // transport phrase in its message.
  if (typeof (error as { statusCode?: unknown }).statusCode === "number") return undefined

  const topCode = (error as { code?: string }).code
  if (typeof topCode === "string" && TRANSPORT_CODES.has(topCode)) {
    return disconnect(topCode)
  }

  const code = findTransportCodeInCause(error.cause)
  if (code) {
    return disconnect(code)
  }

  // Message fallback is a last resort for raw connection errors that carry no
  // errno code.
  const message = typeof error.message === "string" ? error.message : ""
  for (const [pattern, fallbackCode] of TRANSIENT_MESSAGE_CODES) {
    if (pattern.test(message)) return { kind: "provider_transport_disconnect", retryable: true, code: fallbackCode }
  }

  return undefined
}

function findTransportCodeInCause(cause: unknown, depth = 0): string | undefined {
  if (depth > 4 || !cause || typeof cause !== "object") return undefined
  try {
    const code = (cause as { code?: string }).code
    if (typeof code === "string" && TRANSPORT_CODES.has(code)) return code
    return findTransportCodeInCause((cause as { cause?: unknown }).cause, depth + 1)
  } catch {
    return undefined
  }
}
