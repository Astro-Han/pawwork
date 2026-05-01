import { createEffect, on, onCleanup } from "solid-js"
import type { createSessionHistoryWindow } from "@/pages/session/use-session-history-window"

export function createSessionHistoryBackfill(input: {
  routeSessionID: () => string | undefined
  sessionID: () => string | undefined
  messagesReady: () => boolean
  historyWindow: ReturnType<typeof createSessionHistoryWindow>
  historyMore: () => boolean
  historyLoading: () => boolean
  visibleUserMessagesLength: () => number
  userScrolled: () => boolean
  scroller: () => HTMLElement | undefined
}) {
  let fillFrame: number | undefined

  const fill = () => {
    if (fillFrame !== undefined) return

    fillFrame = requestAnimationFrame(() => {
      fillFrame = undefined

      if (!input.sessionID() || !input.messagesReady()) return
      if (input.userScrolled() || input.historyLoading()) return

      const el = input.scroller()
      if (!el) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (input.historyWindow.turnStart() <= 0 && !input.historyMore()) return

      void input.historyWindow.loadAndReveal()
    })
  }

  createEffect(
    on(
      () =>
        [
          input.routeSessionID(),
          input.sessionID(),
          input.messagesReady(),
          input.historyWindow.turnStart(),
          input.historyMore(),
          input.historyLoading(),
          input.userScrolled(),
          input.visibleUserMessagesLength(),
        ] as const,
      ([, id, ready, start, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (start <= 0 && !more) return
        fill()
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
  })

  return { fill }
}
