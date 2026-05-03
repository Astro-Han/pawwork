import { onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { RendererDiagnosticInput } from "@/context/platform"

type DiagnosticsApi = {
  emitRendererDiagnostic?(event: RendererDiagnosticInput): Promise<void>
}

type PerformanceWithMemory = Performance & {
  memory?: {
    usedJSHeapSize?: number
  }
}

let warnedRendererDiagnosticsEmitFailure = false

function warnRendererDiagnosticsEmitFailure(reason: string, error?: unknown) {
  if (!import.meta.env.DEV || warnedRendererDiagnosticsEmitFailure) return
  warnedRendererDiagnosticsEmitFailure = true
  console.warn(`[renderer-diagnostics] ${reason}`, error)
}

export function createRendererDiagnosticsEmitter(input: {
  api?: DiagnosticsApi
  now?: () => number
}) {
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

export function detectSessionScrollJumpToTop(event: RendererDiagnosticInput): RendererDiagnosticInput | undefined {
  if (event.name !== "session.scroll.sample") return
  const scrollTop = numericData(event, "scroll_top")
  const distanceFromBottom = numericData(event, "distance_from_bottom")
  const clientHeight = numericData(event, "client_height")
  const userScrolled = booleanData(event, "user_scrolled")
  if (scrollTop === undefined || distanceFromBottom === undefined || clientHeight === undefined) return
  if (scrollTop > 4 || distanceFromBottom < nearBottomThreshold(clientHeight) || userScrolled) return
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
      const scrollIncident = detectSessionScrollJumpToTop(event)
      const distanceFromBottom = numericData(event, "distance_from_bottom")
      const clientHeight = numericData(event, "client_height")
      const nearBottom =
        distanceFromBottom !== undefined && clientHeight !== undefined
          ? distanceFromBottom <= nearBottomThreshold(clientHeight)
          : false
      const previous = lastScroll.get(sessionKey)
      const submit = recentSubmits.get(sessionKey)
      const monotonic = event.monotonic_ms ?? performance.now()
      if (scrollIncident && previous?.nearBottom && submit && monotonic - submit.monotonicMs <= 2_000) {
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

export function createSessionPerformanceDiagnostics(input: {
  routeSessionID: Accessor<string | undefined>
  visibleSessionID: Accessor<string | undefined>
  timelineSessionID: Accessor<string | undefined>
  emit?: (event: RendererDiagnosticInput) => Promise<void> | void
}) {
  if (!input.emit && (typeof window === "undefined" || !window.api?.emitRendererDiagnostic)) return
  const emit = input.emit ?? emitRendererDiagnostic
  let running = true
  let frame: number | undefined
  let interval: number | undefined
  let lastFrame = performance.now()
  let sampleStartedAt = lastFrame
  let frameCount = 0
  let jankCount = 0
  let maxFrameGap = 0
  let longTaskMax = 0
  let longTaskBlock = 0
  let cls = 0
  let longTaskObserver: PerformanceObserver | undefined
  let layoutShiftObserver: PerformanceObserver | undefined

  const baseEvent = () => ({
    route_session_id: input.routeSessionID(),
    visible_session_id: input.visibleSessionID(),
    timeline_session_id: input.timelineSessionID(),
  })

  const tick = (now: number) => {
    const gap = now - lastFrame
    lastFrame = now
    frameCount += 1
    if (gap > 50) jankCount += 1
    maxFrameGap = Math.max(maxFrameGap, gap)
    if (running) frame = requestAnimationFrame(tick)
  }

  const flush = () => {
    const now = performance.now()
    if (document.visibilityState === "hidden") {
      frameCount = 0
      jankCount = 0
      maxFrameGap = 0
      longTaskMax = 0
      longTaskBlock = 0
      cls = 0
      sampleStartedAt = now
      lastFrame = now
      return
    }
    const elapsedMs = Math.max(1, now - sampleStartedAt)
    const fps = Math.round((frameCount * 1000) / elapsedMs)
    const memory = performance as PerformanceWithMemory
    const roundedFrameGap = Math.round(maxFrameGap)
    const roundedLongTaskMax = Math.round(longTaskMax)
    const base = baseEvent()
    void emit({
      name: "renderer.perf.sample",
      ...base,
      data: {
        fps,
        frame_gap_ms: roundedFrameGap,
        jank_count: jankCount,
        long_task_max_ms: roundedLongTaskMax,
        long_task_block_ms: Math.round(longTaskBlock),
        cls,
        // Chrome exposes usedJSHeapSize in bytes.
        heap_used_mb: memory.memory?.usedJSHeapSize
          ? Math.round(memory.memory.usedJSHeapSize / 1024 / 1024)
          : undefined,
      },
    })
    if (cls >= 0.1) {
      void emit({
        name: "incident.session_layout_shift",
        level: "warn",
        ...base,
        data: { cls, phase: "perf_sample" },
      })
    }
    if (roundedLongTaskMax >= 100 || roundedFrameGap >= 250) {
      void emit({
        name: "incident.session_jank_burst",
        level: "warn",
        ...base,
        data: { long_task_max_ms: roundedLongTaskMax, frame_gap_ms: roundedFrameGap, phase: "perf_sample" },
      })
    }
    frameCount = 0
    jankCount = 0
    maxFrameGap = 0
    longTaskMax = 0
    longTaskBlock = 0
    cls = 0
    sampleStartedAt = now
  }

  if (typeof PerformanceObserver !== "undefined") {
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTaskMax = Math.max(longTaskMax, entry.duration)
          longTaskBlock += entry.duration
        }
      })
      longTaskObserver.observe({ type: "longtask", buffered: true })
    } catch {}

    try {
      layoutShiftObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as PerformanceEntry[]) {
          const value = (entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean }).value
          const hadRecentInput = (entry as PerformanceEntry & { hadRecentInput?: boolean }).hadRecentInput
          if (!hadRecentInput && typeof value === "number") cls += value
        }
      })
      layoutShiftObserver.observe({ type: "layout-shift", buffered: true })
    } catch {}
  }

  frame = requestAnimationFrame(tick)
  interval = window.setInterval(flush, 5_000)

  const onVisibilityChange = () => {
    void emit({
      name: "renderer.visibility",
      ...baseEvent(),
      data: { visibility: document.visibilityState },
    })
  }
  document.addEventListener("visibilitychange", onVisibilityChange)

  onCleanup(() => {
    running = false
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (interval !== undefined) window.clearInterval(interval)
    longTaskObserver?.disconnect()
    layoutShiftObserver?.disconnect()
    document.removeEventListener("visibilitychange", onVisibilityChange)
  })
}
