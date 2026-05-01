import { createEffect, onCleanup } from "solid-js"
import type { DesktopContext } from "@/utils/desktop-context"

export type DesktopContextSender = (context: DesktopContext) => Promise<void>

export function createDesktopContextSync(input: {
  maxRetries: number
  send: DesktopContextSender | undefined
  setTimer: (fn: () => void, delay: number) => number
  clearTimer: (id: number) => void
}) {
  let lastDesktopContext = ""
  let pendingDesktopContext = ""
  let desktopContextRetryTimer: number | undefined
  let desktopContextRetryCount = 0
  let disposed = false

  const clear = () => {
    if (desktopContextRetryTimer !== undefined) {
      input.clearTimer(desktopContextRetryTimer)
      desktopContextRetryTimer = undefined
    }
  }

  const sync = (context: DesktopContext, serialized: string) => {
    if (disposed || !input.send) return
    void input
      .send(context)
      .then(() => {
        if (disposed || pendingDesktopContext !== serialized) return
        lastDesktopContext = serialized
        pendingDesktopContext = ""
        desktopContextRetryCount = 0
        clear()
      })
      .catch(() => {
        if (disposed || pendingDesktopContext !== serialized || lastDesktopContext === serialized) return
        if (desktopContextRetryCount >= input.maxRetries) {
          pendingDesktopContext = ""
          desktopContextRetryCount = 0
          return
        }
        clear()
        desktopContextRetryCount += 1
        const retryDelay = Math.min(4000, 250 * 2 ** (desktopContextRetryCount - 1))
        desktopContextRetryTimer = input.setTimer(() => {
          desktopContextRetryTimer = undefined
          if (disposed || pendingDesktopContext !== serialized || lastDesktopContext === serialized) return
          sync(context, serialized)
        }, retryDelay)
      })
  }

  return {
    push(context: DesktopContext) {
      const serialized = JSON.stringify(context)
      if (serialized === lastDesktopContext || serialized === pendingDesktopContext) return
      pendingDesktopContext = serialized
      desktopContextRetryCount = 0
      sync(context, serialized)
    },
    dispose() {
      disposed = true
      clear()
    },
  }
}

export function useSessionDesktopContext(input: {
  context: () => DesktopContext
  send: DesktopContextSender | undefined
}) {
  const sync = createDesktopContextSync({
    maxRetries: 5,
    send: input.send,
    setTimer: (fn, delay) => window.setTimeout(fn, delay),
    clearTimer: (id) => window.clearTimeout(id),
  })

  createEffect(() => {
    sync.push(input.context())
  })

  onCleanup(sync.dispose)
}
