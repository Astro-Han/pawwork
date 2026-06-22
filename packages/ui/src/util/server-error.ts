// One decode path for a server / assistant error payload, shared by the session
// error card and the toast formatter. It reads the provider's *structured* body
// (the real reason — e.g. a 402 "Insufficient Balance") instead of re-sniffing
// JSON out of a display string, then falls back to the already-extracted
// message. The backend (provider/error.ts) is responsible for putting the real
// reason on the payload; this is the frontend foundation that surfaces it.
//
// Per-kind copy and card visuals are intentionally NOT here — they are the
// design-gated follow-up. This file only turns a payload into the best plain
// text we already have, with no invented copy.

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// Pull a human-readable message out of a structured provider error body. Uses a
// plain JSON.parse (the body is real JSON), not the brittle brace-hunting the
// old session-turn `unwrap` did. Returns undefined when the text is not a
// structured error body, so a clean message passes through unchanged.
function fromStructuredBody(raw: string): string | undefined {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return undefined
  }
  // Some providers double-encode the body as a JSON string.
  if (typeof json === "string") {
    try {
      json = JSON.parse(json.trim())
    } catch {
      return undefined
    }
  }
  if (!record(json)) return undefined

  const err = record(json.error) ? json.error : undefined
  if (err) {
    const type = typeof err.type === "string" ? err.type : undefined
    const message = typeof err.message === "string" ? err.message : undefined
    if (type && message) return `${type}: ${message}`
    if (message) return message
    if (type) return type
    const code = typeof err.code === "string" ? err.code : undefined
    if (code) return code
  }
  if (typeof json.message === "string") return json.message
  if (typeof json.error === "string") return json.error
  return undefined
}

// Decode the best plain-text reason from a server / assistant error payload.
// Returns undefined when the value is not a recognizable error payload (callers
// fall back to their own defaults).
export function decodeServerErrorText(error: unknown): string | undefined {
  if (!record(error)) return undefined
  const data = record(error.data) ? error.data : undefined
  if (!data) return undefined

  const responseBody = typeof data.responseBody === "string" ? data.responseBody : undefined
  if (responseBody) {
    const fromBody = fromStructuredBody(responseBody)
    if (fromBody) return fromBody
  }

  const message = typeof data.message === "string" ? data.message : undefined
  if (message) return fromStructuredBody(message) ?? message
  return undefined
}
