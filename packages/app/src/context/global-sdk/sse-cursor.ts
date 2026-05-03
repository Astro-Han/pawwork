export function createSseCursor() {
  let value: string | undefined

  return {
    current() {
      return value
    },
    update(id: string | undefined) {
      if (!id) return
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
