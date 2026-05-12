export function createSseCursor() {
  let value: string | undefined

  return {
    current() {
      return value
    },
    setCursorForTest(next: string | undefined) {
      value = next || undefined
    },
    update(id: string | undefined) {
      if (!id) return
      // SSE ids come from the server replay layer; keep this helper transport-only.
      value = id
    },
    headers() {
      if (!value) return undefined
      const headers = new Headers()
      headers.set("Last-Event-ID", value)
      return headers
    },
  }
}
