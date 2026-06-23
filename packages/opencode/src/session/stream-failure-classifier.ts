export type TransportDisconnect = {
  kind: "provider_transport_disconnect"
  retryable: boolean
  code: string
}

// errno / undici codes that mean the connection dropped, timed out, or could
// not be established. All are transient (worth retrying) except ENOTFOUND
// (see disconnect()).
const TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN", // transient DNS lookup failure — retry
  "ENOTFOUND", // permanent DNS failure — non-retryable (see disconnect())
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
])

// Connection-dropped signals that can arrive as a bare message with no errno
// code (undici/Node throw these in some paths). Anchored to the whole trimmed
// message: Node/undici set the entire message to exactly "socket hang up" /
// "premature close", so a longer message that merely *contains* the phrase
// (e.g. a structured provider error) is NOT a bare transport failure.
// "terminated" is intentionally excluded — on its own it is undici's generic
// fetch wrapper and is only a transport failure when its cause carries a code.
const BARE_TRANSPORT_MESSAGES: ReadonlyArray<[RegExp, string]> = [
  [/^socket hang up$/i, "SOCKET_HANG_UP"],
  [/^premature close$/i, "PREMATURE_CLOSE"],
]

function disconnect(code: string): TransportDisconnect {
  // ENOTFOUND = the hostname did not resolve (usually a misconfigured base URL
  // that will never resolve), so auto-retrying just stalls the turn. Everything
  // else in TRANSPORT_CODES is transient; EAI_AGAIN (transient DNS) stays
  // retryable. Promote to a set if a second permanent code ever appears.
  return { kind: "provider_transport_disconnect", retryable: code !== "ENOTFOUND", code }
}

export function classifyStreamFailure(error: unknown): TransportDisconnect | undefined {
  if (!(error instanceof Error)) return undefined

  // An error carrying an HTTP statusCode means an HTTP response was received, so
  // it is an API error classified by status downstream (the APICallError branch
  // in fromError, which runs after this). It must not be reclassified as a
  // transport disconnect by a transport-coded cause.
  if (typeof (error as { statusCode?: unknown }).statusCode === "number") return undefined

  const topCode = (error as { code?: string }).code
  if (typeof topCode === "string" && TRANSPORT_CODES.has(topCode)) {
    return disconnect(topCode)
  }

  const code = findTransportCodeInCause(error.cause)
  if (code) {
    return disconnect(code)
  }

  return undefined
}

// Bare connection-dropped message with no errno code — the true last resort,
// applied by fromError only AFTER structured stream/provider parsing fails, so a
// structured error (e.g. invalid_prompt) whose text merely contains a transport
// phrase, or carries it in cause.body, is classified by its real kind instead of
// being mis-read as a retryable disconnect.
export function classifyBareTransportMessage(error: unknown): TransportDisconnect | undefined {
  if (!(error instanceof Error)) return undefined
  if (typeof (error as { statusCode?: unknown }).statusCode === "number") return undefined
  const message = typeof error.message === "string" ? error.message.trim() : ""
  for (const [pattern, code] of BARE_TRANSPORT_MESSAGES) {
    if (pattern.test(message)) return { kind: "provider_transport_disconnect", retryable: true, code }
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
