// One decode path for a server / assistant error payload, shared by the session
// error card and the toast formatter. It prefers the provider's *structured*
// body (the real reason — e.g. a 402 "Insufficient Balance") and otherwise falls
// back to the already-extracted message, recovering a reason from it when the
// backend could only hand back a display string. The backend (provider/error.ts)
// is responsible for putting the real reason on the payload; this is the frontend
// foundation that surfaces it.
//
// Per-kind copy and card visuals are intentionally NOT here — they are the
// design-gated follow-up. This file only turns a payload into the best plain
// text we already have, with no invented copy.

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// Pull a human-readable reason out of a structured provider error body. The
// `responseBody` path is clean JSON, but the `message` fallback can still arrive
// as a display string: a bare `NamedError.Unknown` carries `JSON.stringify(e)`
// (or the SDK's own `Error: {…}` text) with no structured body, so we strip an
// `Error:` prefix and, when a whole-string parse fails, recover the `{…}` slice —
// the same minimal normalization the old session-turn `unwrap` did, kept here and
// tested. Returns undefined when no JSON object is found, so a clean message
// passes through unchanged.
function fromStructuredBody(raw: string): string | undefined {
  const text = raw.replace(/^Error:\s*/, "").trim()

  const parse = (value: string): unknown => {
    try {
      return JSON.parse(value)
    } catch {
      return undefined
    }
  }
  // Some providers double-encode the body as a JSON string.
  const read = (value: string): unknown => {
    const first = parse(value)
    if (typeof first !== "string") return first
    return parse(first.trim())
  }

  let json = read(text)
  if (json === undefined) {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start !== -1 && end > start) json = read(text.slice(start, end + 1))
  }
  if (!record(json)) return undefined

  const err = record(json.error) ? json.error : undefined
  if (err) {
    // Prefer the human message; the machine `type`/`code` is noise next to it
    // ("Insufficient Balance" beats "unknown_error: Insufficient Balance") and is
    // only worth showing when there is no message at all.
    const message = typeof err.message === "string" ? err.message : undefined
    if (message) return message
    const type = typeof err.type === "string" ? err.type : undefined
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
