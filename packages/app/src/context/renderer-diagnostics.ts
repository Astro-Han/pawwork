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
    await emit({
      ...event,
      monotonic_ms: event.monotonic_ms ?? input.now?.() ?? performance.now(),
    })
  }
}

export async function emitRendererDiagnostic(event: RendererDiagnosticInput) {
  const api = typeof window === "undefined" ? undefined : window.api
  await createRendererDiagnosticsEmitter({ api })(event)
}

export function createSessionPerformanceDiagnostics(input: {
  routeSessionID: Accessor<string | undefined>
  visibleSessionID: Accessor<string | undefined>
  timelineSessionID: Accessor<string | undefined>
  emit?: (event: RendererDiagnosticInput) => Promise<void> | void
}) {
  const emit = input.emit ?? emitRendererDiagnostic
  let running = true
  let frame: number | undefined
  let interval: number | undefined
  let lastFrame = performance.now()
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
    const memory = performance as PerformanceWithMemory
    void emit({
      name: "renderer.perf.sample",
      ...baseEvent(),
      data: {
        fps: frameCount,
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
