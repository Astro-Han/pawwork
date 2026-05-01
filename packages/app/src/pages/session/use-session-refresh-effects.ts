import { createEffect, on, onCleanup, untrack } from "solid-js"
import { getSessionPrefetch, SESSION_PREFETCH_TTL } from "@/context/global-sync/session-prefetch"

export function useSessionRefreshEffects(input: {
  directory: () => string
  routeSessionID: () => string | undefined
  timelineSessionID: () => string | undefined
  statusType: (sessionID: string) => string | undefined
  blocked: () => boolean
  hasMessageCache: (sessionID: string) => boolean
  hasTodoCache: (sessionID: string) => boolean
  syncSession: (sessionID: string, options?: { force?: boolean }) => void | Promise<void>
  syncTodo: (sessionID: string, options?: { force?: boolean }) => void | Promise<void>
}) {
  let refreshFrame: number | undefined
  let refreshTimer: number | undefined
  let todoFrame: number | undefined
  let todoTimer: number | undefined

  createEffect(
    on([input.directory, input.routeSessionID] as const, ([, id]) => {
      if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      refreshFrame = undefined
      refreshTimer = undefined
      if (!id) return

      const cached = untrack(() => input.hasMessageCache(id))
      const stale = !cached
        ? false
        : (() => {
            const info = getSessionPrefetch(input.directory(), id)
            if (!info) return true
            return Date.now() - info.at > SESSION_PREFETCH_TTL
          })()
      untrack(() => {
        void input.syncSession(id)
      })

      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = undefined
        refreshTimer = window.setTimeout(() => {
          refreshTimer = undefined
          if (input.routeSessionID() !== id) return
          untrack(() => {
            if (stale) void input.syncSession(id, { force: true })
          })
        }, 0)
      })
    }),
  )

  createEffect(
    on(
      () => {
        const id = input.timelineSessionID()
        return [input.directory(), id, id ? (input.statusType(id) ?? "idle") : "idle", id ? input.blocked() : false] as const
      },
      ([dir, id, status, blocked]) => {
        if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
        if (todoTimer !== undefined) window.clearTimeout(todoTimer)
        todoFrame = undefined
        todoTimer = undefined
        if (!id) return
        if (status === "idle" && !blocked) return
        const cached = untrack(() => input.hasTodoCache(id))

        todoFrame = requestAnimationFrame(() => {
          todoFrame = undefined
          todoTimer = window.setTimeout(() => {
            todoTimer = undefined
            if (input.directory() !== dir || input.timelineSessionID() !== id) return
            untrack(() => {
              void input.syncTodo(id, cached ? { force: true } : undefined)
            })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
    if (todoTimer !== undefined) window.clearTimeout(todoTimer)
  })
}
