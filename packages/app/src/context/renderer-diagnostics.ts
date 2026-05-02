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

export function createRendererDiagnosticsEmitter(input: {
  api?: DiagnosticsApi
  now?: () => number
}) {
  return async (event: RendererDiagnosticInput) => {
    const emit = input.api?.emitRendererDiagnostic
    if (!emit) return
    try {
      await emit({
        ...event,
        monotonic_ms: event.monotonic_ms ?? input.now?.() ?? performance.now(),
      })
    } catch {}
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

export function detectSessionScrollJumpToTop(event: RendererDiagnosticInput): RendererDiagnosticInput | undefined {
  if (event.name !== "session.scroll.sample") return
  const scrollTop = numericData(event, "scroll_top")
  const distanceFromBottom = numericData(event, "distance_from_bottom")
  const clientHeight = numericData(event, "client_height")
  const userScrolled = booleanData(event, "user_scrolled")
  if (scrollTop === undefined || distanceFromBottom === undefined || clientHeight === undefined) return
  if (scrollTop > 4 || distanceFromBottom < Math.max(100, clientHeight / 2) || userScrolled) return
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

  return (event: RendererDiagnosticInput) => {
    const incidents: RendererDiagnosticInput[] = []
    const scrollIncident = detectSessionScrollJumpToTop(event)
    if (scrollIncident) incidents.push(scrollIncident)

    const sessionKey = event.timeline_session_id ?? event.visible_session_id ?? event.route_session_id
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
        incidents.push({
          name: "incident.session_visible_messages_cleared",
          level: "warn",
          route_session_id: event.route_session_id,
          visible_session_id: event.visible_session_id,
          timeline_session_id: event.timeline_session_id,
          data: {
            before_count: before,
            during_count: during,
            after_count: during,
          },
        })
      }
    }

    return incidents
  }
}

const globalIncidentDetector = createRendererIncidentDetector()

export async function emitRendererDiagnostic(event: RendererDiagnosticInput) {
  const api = typeof window === "undefined" ? undefined : window.api
  const emit = createRendererDiagnosticsEmitter({ api })
  await emit(event)
  for (const incident of globalIncidentDetector(event)) {
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
    const elapsedMs = Math.max(1, now - sampleStartedAt)
    const fps = Math.round((frameCount * 1000) / elapsedMs)
    const memory = performance as PerformanceWithMemory
    void emit({
      name: "renderer.perf.sample",
      ...baseEvent(),
      data: {
        fps,
        frame_gap_ms: Math.round(maxFrameGap),
        jank_count: jankCount,
        long_task_max_ms: Math.round(longTaskMax),
        long_task_block_ms: Math.round(longTaskBlock),
        cls,
        heap_used_mb: memory.memory?.usedJSHeapSize
          ? Math.round(memory.memory.usedJSHeapSize / 1024 / 1024)
          : undefined,
      },
    })
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
      longTaskObserver.observe({ entryTypes: ["longtask"] })
    } catch {}

    try {
      layoutShiftObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as PerformanceEntry[]) {
          const value = (entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean }).value
          const hadRecentInput = (entry as PerformanceEntry & { hadRecentInput?: boolean }).hadRecentInput
          if (!hadRecentInput && typeof value === "number") cls += value
        }
      })
      layoutShiftObserver.observe({ entryTypes: ["layout-shift"] })
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
