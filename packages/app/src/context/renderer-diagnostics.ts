import { onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { RendererDiagnosticInput } from "@/context/platform"

type DiagnosticsApi = {
  emitRendererDiagnostic?(event: RendererDiagnosticInput): Promise<void>
}

let warnedRendererDiagnosticsEmitFailure = false

function warnRendererDiagnosticsEmitFailure(reason: string, error?: unknown) {
  if (!import.meta.env.DEV || warnedRendererDiagnosticsEmitFailure) return
  warnedRendererDiagnosticsEmitFailure = true
  console.warn(`[renderer-diagnostics] ${reason}`, error)
}

export function createRendererDiagnosticsEmitter(input: { api?: DiagnosticsApi; now?: () => number }) {
  return async (event: RendererDiagnosticInput) => {
    const emit = input.api?.emitRendererDiagnostic
    if (!emit) {
      warnRendererDiagnosticsEmitFailure("desktop diagnostics API is unavailable")
      return
    }
    try {
      await emit({
        ...event,
        monotonic_ms: event.monotonic_ms ?? input.now?.() ?? performance.now(),
      })
    } catch (error) {
      warnRendererDiagnosticsEmitFailure("failed to emit renderer diagnostic", error)
    }
  }
}

function numericData(event: RendererDiagnosticInput, key: string) {
  const value = event.data?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanData(event: RendererDiagnosticInput, key: string) {
  const value = event.data?.[key]
  return typeof value === "boolean" ? value : undefined
}

function renderedCount(event: RendererDiagnosticInput) {
  return numericData(event, "rendered_count") ?? 0
}

function nearBottomThreshold(clientHeight: number) {
  return Math.min(200, Math.max(80, clientHeight * 0.3))
}

function nearTopThreshold(clientHeight: number) {
  return Math.min(12, Math.max(4, clientHeight * 0.01))
}

export function detectSessionScrollJumpToTop(
  event: RendererDiagnosticInput,
  options?: { allowUserScrolled?: boolean; scrollTopThreshold?: number },
): RendererDiagnosticInput | undefined {
  if (event.name !== "session.scroll.sample") return
  const scrollTop = numericData(event, "scroll_top")
  const distanceFromBottom = numericData(event, "distance_from_bottom")
  const clientHeight = numericData(event, "client_height")
  const userScrolled = booleanData(event, "user_scrolled")
  if (scrollTop === undefined || distanceFromBottom === undefined || clientHeight === undefined) return
  const scrollTopThreshold = options?.scrollTopThreshold ?? 4
  if (
    scrollTop > scrollTopThreshold ||
    distanceFromBottom < nearBottomThreshold(clientHeight) ||
    (userScrolled && !options?.allowUserScrolled)
  ) {
    return
  }
  return {
    name: "incident.session_scroll_jump_to_top",
    level: "warn",
    route_session_id: event.route_session_id,
    visible_session_id: event.visible_session_id,
    timeline_session_id: event.timeline_session_id,
    trace_id: event.trace_id,
    data: {
      scroll_top: scrollTop,
      distance_from_bottom: distanceFromBottom,
      client_height: clientHeight,
      user_scrolled: userScrolled ?? false,
    },
  }
}

export function createRendererIncidentDetector() {
  const timelineMounts = new Map<string, { mounts: number; unmounts: number }>()
  const visibleCounts = new Map<string, number>()
  const pendingVisibleClears = new Map<string, { before: number }>()
  const lastScroll = new Map<string, { nearBottom: boolean }>()
  const recentSubmits = new Map<string, { traceID?: string; monotonicMs: number }>()

  return (event: RendererDiagnosticInput) => {
    const incidents: RendererDiagnosticInput[] = []
    const sessionKey = event.timeline_session_id ?? event.visible_session_id ?? event.route_session_id

    if (sessionKey && event.name === "session.action.submit") {
      recentSubmits.set(sessionKey, {
        traceID: event.trace_id,
        monotonicMs: event.monotonic_ms ?? performance.now(),
      })
    }

    if (sessionKey && event.name === "session.scroll.sample") {
      const distanceFromBottom = numericData(event, "distance_from_bottom")
      const clientHeight = numericData(event, "client_height")
      const nearBottom =
        distanceFromBottom !== undefined && clientHeight !== undefined
          ? distanceFromBottom <= nearBottomThreshold(clientHeight)
          : false
      const previous = lastScroll.get(sessionKey)
      const submit = recentSubmits.get(sessionKey)
      const monotonic = event.monotonic_ms ?? performance.now()
      const submittedFromBottom = !!(previous?.nearBottom && submit && monotonic - submit.monotonicMs <= 2_000)
      const scrollIncident = detectSessionScrollJumpToTop(event, {
        allowUserScrolled: submittedFromBottom,
        scrollTopThreshold:
          submittedFromBottom && clientHeight !== undefined ? nearTopThreshold(clientHeight) : undefined,
      })
      if (scrollIncident && submittedFromBottom) {
        incidents.push({
          ...scrollIncident,
          trace_id: scrollIncident.trace_id ?? submit.traceID,
        })
      }
      lastScroll.set(sessionKey, { nearBottom })
    }

    if (sessionKey && (event.name === "session.timeline.mount" || event.name === "session.timeline.unmount")) {
      const counts = timelineMounts.get(sessionKey) ?? { mounts: 0, unmounts: 0 }
      if (event.name === "session.timeline.mount") counts.mounts += 1
      else counts.unmounts += 1
      timelineMounts.set(sessionKey, counts)
      if (event.name === "session.timeline.mount" && counts.mounts > 1 && counts.unmounts > 0) {
        incidents.push({
          name: "incident.session_timeline_remount",
          level: "warn",
          route_session_id: event.route_session_id,
          visible_session_id: event.visible_session_id,
          timeline_session_id: event.timeline_session_id,
          data: {
            timeline_mount_count: counts.mounts,
            timeline_unmount_count: counts.unmounts,
          },
        })
      }
    }

    if (sessionKey && event.name === "session.timeline.visible") {
      const before = visibleCounts.get(sessionKey) ?? 0
      const during = renderedCount(event)
      visibleCounts.set(sessionKey, during)
      if (before > 0 && during === 0) {
        pendingVisibleClears.set(sessionKey, { before })
      } else if (during > 0) {
        const pending = pendingVisibleClears.get(sessionKey)
        if (pending) {
          pendingVisibleClears.delete(sessionKey)
          incidents.push({
            name: "incident.session_visible_messages_cleared",
            level: "warn",
            route_session_id: event.route_session_id,
            visible_session_id: event.visible_session_id,
            timeline_session_id: event.timeline_session_id,
            data: {
              before_count: pending.before,
              during_count: 0,
              after_count: during,
            },
          })
        }
      }
    }

    return incidents
  }
}

const globalIncidentDetector = createRendererIncidentDetector()

export async function emitRendererDiagnostic(event: RendererDiagnosticInput) {
  const api = typeof window === "undefined" ? undefined : window.api
  const emit = createRendererDiagnosticsEmitter({ api })
  const timedEvent = {
    ...event,
    monotonic_ms: event.monotonic_ms ?? performance.now(),
  }
  await emit(timedEvent)
  for (const incident of globalIncidentDetector(timedEvent)) {
    await emit(incident)
  }
}

export function sessionAbortDiagnosticEvent(input: {
  routeSessionID?: string
  visibleSessionID?: string
  timelineSessionID?: string
  source: string
  result: "aborted" | "ignored_awaiting_question"
}): RendererDiagnosticInput {
  return {
    name: "session.action.abort",
    route_session_id: input.routeSessionID,
    visible_session_id: input.visibleSessionID,
    timeline_session_id: input.timelineSessionID,
    data: {
      source: input.source,
      result: input.result,
    },
  }
}

export function createSessionPerformanceDiagnostics(input: {
  routeSessionID: Accessor<string | undefined>
  visibleSessionID: Accessor<string | undefined>
  timelineSessionID: Accessor<string | undefined>
  emit?: (event: RendererDiagnosticInput) => Promise<void> | void
}) {
  if (!input.emit && (typeof window === "undefined" || !window.api?.emitRendererDiagnostic)) return
  const emit = input.emit ?? emitRendererDiagnostic
  let active = true
  let cls = 0
  let clsWindowStartedAt: number | undefined
  let clsLastShiftAt: number | undefined
  let clsIncidentEmitted = false
  let longTaskObserver: PerformanceObserver | undefined
  let layoutShiftObserver: PerformanceObserver | undefined

  const baseEvent = () => ({
    route_session_id: input.routeSessionID(),
    visible_session_id: input.visibleSessionID(),
    timeline_session_id: input.timelineSessionID(),
  })

  if (typeof PerformanceObserver !== "undefined") {
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        if (!active) return
        let maxDuration = 0
        for (const entry of list.getEntries()) {
          maxDuration = Math.max(maxDuration, Math.round(entry.duration))
        }
        if (maxDuration < 100) return
        void emit({
          name: "incident.session_jank_burst",
          level: "warn",
          ...baseEvent(),
          data: { long_task_max_ms: maxDuration, phase: "performance_observer" },
        })
      })
      longTaskObserver.observe({ type: "longtask", buffered: true })
    } catch {}

    try {
      layoutShiftObserver = new PerformanceObserver((list) => {
        if (!active) return
        for (const entry of list.getEntries() as PerformanceEntry[]) {
          const value = (entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean }).value
          const hadRecentInput = (entry as PerformanceEntry & { hadRecentInput?: boolean }).hadRecentInput
          if (hadRecentInput || typeof value !== "number") continue
          const continuesWindow =
            clsWindowStartedAt !== undefined &&
            clsLastShiftAt !== undefined &&
            entry.startTime - clsLastShiftAt < 1_000 &&
            entry.startTime - clsWindowStartedAt < 5_000
          if (continuesWindow) {
            cls += value
          } else {
            cls = value
            clsWindowStartedAt = entry.startTime
            clsIncidentEmitted = false
          }
          clsLastShiftAt = entry.startTime
          if (cls < 0.1 || clsIncidentEmitted) continue
          clsIncidentEmitted = true
          void emit({
            name: "incident.session_layout_shift",
            level: "warn",
            ...baseEvent(),
            data: { cls, phase: "performance_observer" },
          })
        }
      })
      layoutShiftObserver.observe({ type: "layout-shift", buffered: true })
    } catch {}
  }

  const onVisibilityChange = () => {
    if (!active) return
    void emit({
      name: "renderer.visibility",
      ...baseEvent(),
      data: { visibility: document.visibilityState },
    })
  }
  document.addEventListener("visibilitychange", onVisibilityChange)

  onCleanup(() => {
    active = false
    longTaskObserver?.disconnect()
    layoutShiftObserver?.disconnect()
    document.removeEventListener("visibilitychange", onVisibilityChange)
  })
}
