import { createEffect, on, onCleanup, untrack } from "solid-js"
import { getSessionPrefetch, SESSION_PREFETCH_TTL } from "@/context/global-sync/session-prefetch"
import type { RendererDiagnosticInput } from "@/context/platform"

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
  emitRendererDiagnostic?: (event: RendererDiagnosticInput) => void | Promise<void>
}) {
  let refreshFrame: number | undefined
  let refreshTimer: number | undefined
  let todoFrame: number | undefined
  let todoTimer: number | undefined

  const emitRefresh = (event: RendererDiagnosticInput) => {
    void input.emitRendererDiagnostic?.(event)
  }

  const syncSessionWithDiagnostics = (id: string, options: { force?: boolean } | undefined, cachePresent: boolean) => {
    const startedAt = performance.now()
    const phase = options?.force ? "message_force" : "message"
    emitRefresh({
      name: "session.data.refresh",
      route_session_id: id,
      visible_session_id: input.timelineSessionID(),
      timeline_session_id: input.timelineSessionID(),
      data: { phase: `${phase}_start`, cache_present: cachePresent },
    })
    void Promise.resolve(input.syncSession(id, options))
      .then(() => {
        emitRefresh({
          name: "session.data.refresh",
          route_session_id: id,
          visible_session_id: input.timelineSessionID(),
          timeline_session_id: input.timelineSessionID(),
          data: {
            phase: `${phase}_end`,
            duration_ms: Math.round(performance.now() - startedAt),
            cache_present: input.hasMessageCache(id),
          },
        })
      })
      .catch(() => {
        emitRefresh({
          name: "session.data.refresh",
          route_session_id: id,
          visible_session_id: input.timelineSessionID(),
          timeline_session_id: input.timelineSessionID(),
          data: {
            phase: `${phase}_failed`,
            duration_ms: Math.round(performance.now() - startedAt),
            cache_present: input.hasMessageCache(id),
          },
        })
      })
  }

  const syncTodoWithDiagnostics = (id: string, options: { force?: boolean } | undefined, cachePresent: boolean) => {
    const startedAt = performance.now()
    const phase = options?.force ? "todo_force" : "todo"
    emitRefresh({
      name: "session.data.refresh",
      route_session_id: input.routeSessionID(),
      visible_session_id: id,
      timeline_session_id: id,
      data: { phase: `${phase}_start`, cache_present: cachePresent },
    })
    void Promise.resolve(input.syncTodo(id, options))
      .then(() => {
        emitRefresh({
          name: "session.data.refresh",
          route_session_id: input.routeSessionID(),
          visible_session_id: id,
          timeline_session_id: id,
          data: {
            phase: `${phase}_end`,
            duration_ms: Math.round(performance.now() - startedAt),
            cache_present: input.hasTodoCache(id),
          },
        })
      })
      .catch(() => {
        emitRefresh({
          name: "session.data.refresh",
          route_session_id: input.routeSessionID(),
          visible_session_id: id,
          timeline_session_id: id,
          data: {
            phase: `${phase}_failed`,
            duration_ms: Math.round(performance.now() - startedAt),
            cache_present: input.hasTodoCache(id),
          },
        })
      })
  }

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
        syncSessionWithDiagnostics(id, undefined, cached)
      })

      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = undefined
        refreshTimer = window.setTimeout(() => {
          refreshTimer = undefined
          if (input.routeSessionID() !== id) return
          untrack(() => {
            if (stale) syncSessionWithDiagnostics(id, { force: true }, cached)
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
              syncTodoWithDiagnostics(id, cached ? { force: true } : undefined, cached)
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
