export function createQuestionRefetchRunner(input: {
  getFallbackSessionID: () => string | undefined
  refetch: (sessionID: string) => Promise<unknown>
  queue?: (callback: () => void) => void
}) {
  const inflight = new Set<string>()
  const queue = input.queue ?? queueMicrotask
  let disposed = false

  const start = (sessionID: string | undefined) => {
    if (disposed) return
    if (!sessionID || inflight.has(sessionID)) return

    inflight.add(sessionID)
    input
      .refetch(sessionID)
      .catch(() => {})
      .finally(() => {
        inflight.delete(sessionID)
        if (disposed) return
        const next = input.getFallbackSessionID()
        if (next && next !== sessionID && !inflight.has(next)) queue(() => start(next))
      })
  }

  return {
    start,
    dispose: () => {
      disposed = true
      inflight.clear()
    },
  }
}
