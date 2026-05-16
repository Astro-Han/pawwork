import { createEffect, createMemo, on } from "solid-js"
import {
  createSessionPerformanceDiagnostics,
  emitRendererDiagnostic,
  sessionAbortDiagnosticEvent,
} from "@/context/renderer-diagnostics"

interface SessionPageDiagnosticsOptions {
  routeSessionID: () => string | undefined
  timelineSessionID: () => string | undefined
  routeMessagesReady: () => boolean
  visibleMessagesReady: () => boolean
  actionReady: () => boolean
  messageCachePresent: () => boolean
  sessionInfoPresent: () => boolean
  statusKnown: () => boolean
  historyMore: () => boolean
  historyLoading: () => boolean
  messages: () => unknown[]
}

const countMessageParts = (message: unknown) => {
  if (!message || typeof message !== "object" || !("parts" in message)) return 0
  const parts = (message as { parts?: unknown }).parts
  return Array.isArray(parts) ? parts.length : 0
}

export function createSessionPageDiagnostics(options: SessionPageDiagnosticsOptions) {
  const timelineMessageMetrics = createMemo(() => {
    const messages = options.messages()
    return {
      messageCount: messages.length,
      partCount: messages.reduce<number>((count, message) => count + countMessageParts(message), 0),
    }
  })
  const emitDiagnostics = (event: Parameters<typeof emitRendererDiagnostic>[0]) => {
    void emitRendererDiagnostic(event).catch(() => undefined)
  }

  const emitAbortDiagnostic = (
    sessionID: string,
    source: "revert" | "autoHeal",
    result: "aborted" | "ignored_awaiting_question",
  ) => {
    const timelineSessionID = options.timelineSessionID()
    emitDiagnostics(
      sessionAbortDiagnosticEvent({
        routeSessionID: options.routeSessionID(),
        visibleSessionID: timelineSessionID,
        timelineSessionID,
        source,
        mode: "hard",
        result,
      }),
    )
  }

  createEffect(
    on(
      () => {
        const routeSessionID = options.routeSessionID()
        const visibleSessionID = options.timelineSessionID()
        const metrics = timelineMessageMetrics()
        return {
          routeSessionID,
          visibleSessionID,
          routeReady: options.routeMessagesReady(),
          visibleReady: options.visibleMessagesReady(),
          actionReady: options.actionReady(),
          messageCachePresent: options.messageCachePresent(),
          sessionInfoPresent: options.sessionInfoPresent(),
          statusKnown: options.statusKnown(),
          transitioning: !!routeSessionID && !!visibleSessionID && routeSessionID !== visibleSessionID,
          messageCount: metrics.messageCount,
          partCount: metrics.partCount,
          historyMore: options.historyMore(),
          historyLoading: options.historyLoading(),
        }
      },
      (state) => {
        emitDiagnostics({
          name: "session.view.state",
          route_session_id: state.routeSessionID,
          visible_session_id: state.visibleSessionID,
          timeline_session_id: state.visibleSessionID,
          data: {
            route_session_id: state.routeSessionID,
            visible_session_id: state.visibleSessionID,
            timeline_session_id: state.visibleSessionID,
            route_ready: state.routeReady,
            visible_ready: state.visibleReady,
            action_ready: state.actionReady,
            message_cache_present: state.messageCachePresent,
            session_info_present: state.sessionInfoPresent,
            status_known: state.statusKnown,
            transitioning: state.transitioning,
            message_count: state.messageCount,
            part_count: state.partCount,
            history_more: state.historyMore,
            history_loading: state.historyLoading,
          },
        })
      },
    ),
  )

  createEffect(
    on(
      () => {
        const id = options.timelineSessionID()
        return { routeSessionID: options.routeSessionID(), visibleSessionID: id, timelineSessionID: id }
      },
      (next, previous) => {
        if (!previous) return
        if (
          next.routeSessionID === previous.routeSessionID &&
          next.visibleSessionID === previous.visibleSessionID &&
          next.timelineSessionID === previous.timelineSessionID
        ) {
          return
        }
        emitDiagnostics({
          name: "session.identity.transition",
          route_session_id: next.routeSessionID,
          visible_session_id: next.visibleSessionID,
          timeline_session_id: next.timelineSessionID,
          data: {
            from_route_session_id: previous.routeSessionID,
            to_route_session_id: next.routeSessionID,
            from_visible_session_id: previous.visibleSessionID,
            to_visible_session_id: next.visibleSessionID,
            from_timeline_session_id: previous.timelineSessionID,
            to_timeline_session_id: next.timelineSessionID,
          },
        })
      },
      { defer: true },
    ),
  )

  createSessionPerformanceDiagnostics({
    routeSessionID: options.routeSessionID,
    visibleSessionID: options.timelineSessionID,
    timelineSessionID: options.timelineSessionID,
  })

  return {
    emitAbortDiagnostic,
    emitDiagnostics,
  }
}
