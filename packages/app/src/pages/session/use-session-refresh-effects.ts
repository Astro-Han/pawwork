import { createEffect, on, onCleanup, untrack } from "solid-js"
import { getSessionPrefetch, SESSION_PREFETCH_TTL } from "@/context/global-sync/session-prefetch"
import type { TodoHydrateReason } from "@/context/global-sync/todo-hydrate-coordinator"
import type { RendererDiagnosticInput } from "@/context/platform"

type TodoSyncOptions = {
  force?: boolean
  reason?: TodoHydrateReason
}

export function useSessionRefreshEffects(input: {
  directory: () => string
  routeSessionID: () => string | undefined
  timelineSessionID: () => string | undefined
  statusType: (sessionID: string) => string | undefined
  blocked: () => boolean
  hasMessageCache: (sessionID: string) => boolean
  hasTodoCache: (sessionID: string) => boolean
  isTodoInvalidated?: (sessionID: string) => boolean
  scheduleTodoHydrate?: (directory: string, sessionID: string, reason: TodoHydrateReason) => void
  cancelTodoHydrate?: (directory: string, sessionID: string) => void
  recoveryEpoch?: () => number
  validatedRecoveryEpoch?: (directory: string, sessionID: string) => number
  syncSession: (sessionID: string, options?: { force?: boolean }) => void | Promise<void>
  syncTodo: (sessionID: string, options?: TodoSyncOptions) => void | Promise<void>
  emitRendererDiagnostic?: (event: RendererDiagnosticInput) => void | Promise<void>
}) {
  let refreshFrame: number | undefined
  let refreshTimer: number | undefined
  let todoFrame: number | undefined
  let todoTimer: number | undefined
  let scheduledTodo: { directory: string; sessionID: string } | undefined

  const emitRefresh = (event: RendererDiagnosticInput) => {
    try {
      const pending = input.emitRendererDiagnostic?.(event)
      void Promise.resolve(pending).catch(() => undefined)
    } catch {}
  }

  const syncSessionWithDiagnostics = (id: string, options: { force?: boolean } | undefined, cachePresent: boolean) => {
    const startedAt = performance.now()
    const visibleSessionID = input.timelineSessionID()
    const phase = options?.force ? "message_force" : "message"
    emitRefresh({
      name: "session.data.refresh",
      route_session_id: id,
      visible_session_id: visibleSessionID,
      timeline_session_id: visibleSessionID,
      data: { phase: `${phase}_start`, cache_present: cachePresent },
    })
    void Promise.resolve(input.syncSession(id, options))
      .then(() => {
        emitRefresh({
          name: "session.data.refresh",
          route_session_id: id,
          visible_session_id: visibleSessionID,
          timeline_session_id: visibleSessionID,
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
          visible_session_id: visibleSessionID,
          timeline_session_id: visibleSessionID,
          data: {
            phase: `${phase}_failed`,
            duration_ms: Math.round(performance.now() - startedAt),
            cache_present: input.hasMessageCache(id),
          },
        })
      })
  }

  const cancelScheduledTodo = () => {
    if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
    if (todoTimer !== undefined) window.clearTimeout(todoTimer)
    todoFrame = undefined
    todoTimer = undefined
    const pending = scheduledTodo
    scheduledTodo = undefined
    if (pending) input.cancelTodoHydrate?.(pending.directory, pending.sessionID)
  }

  const syncTodoWithDiagnostics = (id: string, options: TodoSyncOptions | undefined, cachePresent: boolean) => {
    const startedAt = performance.now()
    const routeSessionID = input.routeSessionID()
    const phase = options?.force ? "todo_force" : "todo"
    emitRefresh({
      name: "session.data.refresh",
      route_session_id: routeSessionID,
      visible_session_id: id,
      timeline_session_id: id,
      data: { phase: `${phase}_start`, cache_present: cachePresent },
    })
    void Promise.resolve(input.syncTodo(id, options))
      .then(() => {
        emitRefresh({
          name: "session.data.refresh",
          route_session_id: routeSessionID,
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
          route_session_id: routeSessionID,
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
        const dir = input.directory()
        return [
          dir,
          id,
          id ? (input.statusType(id) ?? "idle") : "idle",
          id ? input.blocked() : false,
          input.recoveryEpoch?.() ?? 0,
          id ? (input.validatedRecoveryEpoch?.(dir, id) ?? 0) : 0,
        ] as const
      },
      ([dir, id, status, blocked, recoveryEpoch, recoveryValidated]) => {
        cancelScheduledTodo()
        if (!id) return
        if (input.isTodoInvalidated?.(id)) return
        const cached = untrack(() => input.hasTodoCache(id))
        const recoveryDue = cached && recoveryEpoch > recoveryValidated
        const busy = status !== "idle" || blocked
        const reason: TodoHydrateReason | undefined = recoveryDue ? "recovery" : busy ? "busy" : cached ? undefined : "visible"
        if (!reason) return

        input.scheduleTodoHydrate?.(dir, id, reason)
        scheduledTodo = { directory: dir, sessionID: id }

        todoFrame = requestAnimationFrame(() => {
          todoFrame = undefined
          todoTimer = window.setTimeout(() => {
            todoTimer = undefined
            if (input.directory() !== dir || input.timelineSessionID() !== id) return
            scheduledTodo = undefined
            untrack(() => {
              if (input.isTodoInvalidated?.(id)) {
                input.cancelTodoHydrate?.(dir, id)
                return
              }
              const currentCached = input.hasTodoCache(id)
              if (reason === "visible" && currentCached) {
                input.cancelTodoHydrate?.(dir, id)
                return
              }
              syncTodoWithDiagnostics(id, { force: recoveryDue || (busy && currentCached), reason }, cached)
            })
          }, 0)
        })
      },
    ),
  )

  onCleanup(() => {
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    cancelScheduledTodo()
  })
}
