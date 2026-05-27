export type TransportDisconnect = {
  kind: "provider_transport_disconnect"
  retryable: true
  code: string
}

const TRANSPORT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_SOCKET"])

export function classifyStreamFailure(error: unknown): TransportDisconnect | undefined {
  if (!(error instanceof Error)) return undefined

  const topCode = (error as { code?: string }).code
  if (typeof topCode === "string" && TRANSPORT_CODES.has(topCode)) {
    return { kind: "provider_transport_disconnect", retryable: true, code: topCode }
  }

  const code = findTransportCodeInCause(error.cause)
  if (code) {
    return { kind: "provider_transport_disconnect", retryable: true, code }
  }

  return undefined
}

function findTransportCodeInCause(cause: unknown, depth = 0): string | undefined {
  if (depth > 4 || !cause || typeof cause !== "object") return undefined
  const code = (cause as { code?: string }).code
  if (typeof code === "string" && TRANSPORT_CODES.has(code)) return code
  return findTransportCodeInCause((cause as { cause?: unknown }).cause, depth + 1)
}
