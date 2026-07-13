import { afterEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import {
  createRendererDiagnosticsEmitter,
  createRendererIncidentDetector,
  createSessionPerformanceDiagnostics,
  detectSessionScrollJumpToTop,
} from "./renderer-diagnostics"
import type { RendererDiagnosticInput } from "./platform"

describe("renderer diagnostics", () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const originalSetInterval = window.setInterval
  const originalPerformanceObserver = globalThis.PerformanceObserver
  const originalApi = window.api

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame
    window.setInterval = originalSetInterval
    globalThis.PerformanceObserver = originalPerformanceObserver
    window.api = originalApi
  })

  function capturePerformanceObservers() {
    const callbacks = new Map<string, PerformanceObserverCallback>()
    globalThis.PerformanceObserver = class {
      constructor(callback: PerformanceObserverCallback) {
        this.callback = callback
      }

      private callback: PerformanceObserverCallback

      observe(options: PerformanceObserverInit) {
        if (options.type) callbacks.set(options.type, this.callback)
      }

      disconnect() {}
      takeRecords() {
        return []
      }
    } as unknown as typeof PerformanceObserver

    return (type: string, entries: PerformanceEntry[]) => {
      callbacks.get(type)?.({ getEntries: () => entries } as PerformanceObserverEntryList, {} as PerformanceObserver)
    }
  }

  function layoutShift(startTime: number, value: number) {
    return { startTime, value, hadRecentInput: false } as unknown as PerformanceEntry
  }

  test("emits through the desktop API with monotonic time", async () => {
    const events: RendererDiagnosticInput[] = []
    const emit = createRendererDiagnosticsEmitter({
      api: {
        emitRendererDiagnostic: async (event) => {
          events.push(event)
        },
      },
      now: () => 42,
    })

    await emit({ name: "session.action.submit", route_session_id: "session-1" })

    expect(events).toEqual([{ name: "session.action.submit", route_session_id: "session-1", monotonic_ms: 42 }])
  })

  test("session performance diagnostics registers cleanup-safe observers", () => {
    const events: RendererDiagnosticInput[] = []
    createRoot((dispose) => {
      createSessionPerformanceDiagnostics({
        routeSessionID: () => "route-session",
        visibleSessionID: () => "visible-session",
        timelineSessionID: () => "timeline-session",
        emit: (event) => {
          events.push(event)
        },
      })

      document.dispatchEvent(new Event("visibilitychange"))
      dispose()
    })

    expect(events[0]).toMatchObject({
      name: "renderer.visibility",
      route_session_id: "route-session",
      visible_session_id: "visible-session",
      timeline_session_id: "timeline-session",
    })
  })

  test("session performance diagnostics does not start timers without a diagnostics target", () => {
    let frames = 0
    window.api = undefined
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames += 1
      return originalRequestAnimationFrame(callback)
    }) as typeof requestAnimationFrame

    createRoot((dispose) => {
      createSessionPerformanceDiagnostics({
        routeSessionID: () => "route-session",
        visibleSessionID: () => "visible-session",
        timelineSessionID: () => "timeline-session",
      })
      dispose()
    })

    expect(frames).toBe(0)
  })

  test("session performance diagnostics stays passive while a visible session is idle", () => {
    let frames = 0
    let intervals = 0
    globalThis.requestAnimationFrame = (() => {
      frames += 1
      return 1
    }) as typeof requestAnimationFrame
    window.setInterval = (() => {
      intervals += 1
      return 1
    }) as unknown as typeof setInterval

    createRoot((dispose) => {
      createSessionPerformanceDiagnostics({
        routeSessionID: () => "route-session",
        visibleSessionID: () => "visible-session",
        timelineSessionID: () => "timeline-session",
        emit: () => {},
      })
      document.dispatchEvent(new Event("visibilitychange"))
      dispose()
    })

    expect(frames).toBe(0)
    expect(intervals).toBe(0)
  })

  test("emits one jank incident with the maximum long task in an observer batch", () => {
    const notify = capturePerformanceObservers()
    const events: RendererDiagnosticInput[] = []

    createRoot((dispose) => {
      createSessionPerformanceDiagnostics({
        routeSessionID: () => "route-session",
        visibleSessionID: () => "visible-session",
        timelineSessionID: () => "timeline-session",
        emit: (event) => {
          events.push(event)
        },
      })

      notify("longtask", [
        { duration: 99.4 } as PerformanceEntry,
        { duration: 100.4 } as PerformanceEntry,
        { duration: 175.6 } as PerformanceEntry,
        { duration: 130.2 } as PerformanceEntry,
      ])
      dispose()
    })

    expect(events).toEqual([
      {
        name: "incident.session_jank_burst",
        level: "warn",
        route_session_id: "route-session",
        visible_session_id: "visible-session",
        timeline_session_id: "timeline-session",
        data: { long_task_max_ms: 176, phase: "performance_observer" },
      },
    ])
  })

  test("emits once per CLS session window and resets at the gap and duration boundaries", () => {
    const notify = capturePerformanceObservers()
    const events: RendererDiagnosticInput[] = []

    createRoot((dispose) => {
      createSessionPerformanceDiagnostics({
        routeSessionID: () => "route-session",
        visibleSessionID: () => "visible-session",
        timelineSessionID: () => "timeline-session",
        emit: (event) => {
          events.push(event)
        },
      })

      notify("layout-shift", [
        layoutShift(0, 0.06),
        layoutShift(999, 0.05),
        layoutShift(1_500, 0.2),
        // An exact one-second gap starts a new session window.
        layoutShift(2_500, 0.06),
        layoutShift(3_499, 0.05),
        // A third window stays active until exactly five seconds after its first shift.
        layoutShift(4_499, 0.01),
        layoutShift(5_498, 0.01),
        layoutShift(6_497, 0.01),
        layoutShift(7_496, 0.01),
        layoutShift(8_495, 0.01),
        layoutShift(9_494, 0.01),
        layoutShift(9_499, 0.06),
        layoutShift(10_498, 0.05),
      ])
      dispose()
    })

    expect(events).toEqual(
      Array.from({ length: 3 }, () => ({
        name: "incident.session_layout_shift",
        level: "warn",
        route_session_id: "route-session",
        visible_session_id: "visible-session",
        timeline_session_id: "timeline-session",
        data: { cls: 0.11, phase: "performance_observer" },
      })),
    )
  })

  test("does not emit observer or visibility events after cleanup", () => {
    const notify = capturePerformanceObservers()
    const events: RendererDiagnosticInput[] = []

    createRoot((dispose) => {
      createSessionPerformanceDiagnostics({
        routeSessionID: () => "route-session",
        visibleSessionID: () => "visible-session",
        timelineSessionID: () => "timeline-session",
        emit: (event) => {
          events.push(event)
        },
      })
      dispose()
    })

    notify("longtask", [{ duration: 120 } as PerformanceEntry])
    notify("layout-shift", [layoutShift(100, 0.2)])
    document.dispatchEvent(new Event("visibilitychange"))

    expect(events).toEqual([])
  })

  test("detects automatic scroll jumps to top", () => {
    const incident = detectSessionScrollJumpToTop({
      name: "session.scroll.sample",
      route_session_id: "session-1",
      visible_session_id: "session-1",
      timeline_session_id: "session-1",
      data: {
        scroll_top: 0,
        distance_from_bottom: 800,
        client_height: 500,
        user_scrolled: false,
      },
    })

    expect(incident).toMatchObject({
      name: "incident.session_scroll_jump_to_top",
      level: "warn",
      route_session_id: "session-1",
      data: {
        scroll_top: 0,
        distance_from_bottom: 800,
        client_height: 500,
        user_scrolled: false,
      },
    })
  })

  test("does not flag user-driven scroll to top", () => {
    expect(
      detectSessionScrollJumpToTop({
        name: "session.scroll.sample",
        data: {
          scroll_top: 0,
          distance_from_bottom: 800,
          client_height: 500,
          user_scrolled: true,
        },
      }),
    ).toBeUndefined()
  })

  test("detects scroll jumps after submit from a near-bottom state", () => {
    const detect = createRendererIncidentDetector()
    detect({
      name: "session.action.submit",
      route_session_id: "session-1",
      visible_session_id: "session-1",
      timeline_session_id: "session-1",
      trace_id: "message-1",
      monotonic_ms: 1000,
      data: { action: "submit" },
    })
    expect(
      detect({
        name: "session.scroll.sample",
        route_session_id: "session-1",
        visible_session_id: "session-1",
        timeline_session_id: "session-1",
        monotonic_ms: 1200,
        data: { scroll_top: 500, distance_from_bottom: 20, client_height: 500, user_scrolled: false },
      }),
    ).toEqual([])

    expect(
      detect({
        name: "session.scroll.sample",
        route_session_id: "session-1",
        visible_session_id: "session-1",
        timeline_session_id: "session-1",
        monotonic_ms: 1300,
        data: { scroll_top: 0, distance_from_bottom: 800, client_height: 500, user_scrolled: false },
      }),
    ).toEqual([
      expect.objectContaining({
        name: "incident.session_scroll_jump_to_top",
        trace_id: "message-1",
      }),
    ])
  })

  test("detects submit scroll jumps that browser focus marked as user scrolled", () => {
    const detect = createRendererIncidentDetector()
    detect({
      name: "session.action.submit",
      route_session_id: "session-1",
      visible_session_id: "session-1",
      timeline_session_id: "session-1",
      trace_id: "message-1",
      monotonic_ms: 1000,
      data: { action: "submit" },
    })
    expect(
      detect({
        name: "session.scroll.sample",
        route_session_id: "session-1",
        visible_session_id: "session-1",
        timeline_session_id: "session-1",
        monotonic_ms: 1200,
        data: {
          scroll_top: 14327,
          distance_from_bottom: 0,
          client_height: 905,
          user_scrolled: false,
        },
      }),
    ).toEqual([])

    expect(
      detect({
        name: "session.scroll.sample",
        route_session_id: "session-1",
        visible_session_id: "session-1",
        timeline_session_id: "session-1",
        monotonic_ms: 2000,
        data: {
          scroll_top: 5,
          distance_from_bottom: 14322,
          client_height: 905,
          user_scrolled: true,
        },
      }),
    ).toEqual([
      expect.objectContaining({
        name: "incident.session_scroll_jump_to_top",
        trace_id: "message-1",
        data: expect.objectContaining({
          scroll_top: 5,
          distance_from_bottom: 14322,
          user_scrolled: true,
        }),
      }),
    ])
  })

  test("detects timeline remounts and recovered visible message clears", () => {
    const detect = createRendererIncidentDetector()

    expect(detect({ name: "session.timeline.mount", timeline_session_id: "session-1", data: {} })).toEqual([])
    expect(
      detect({ name: "session.timeline.visible", timeline_session_id: "session-1", data: { rendered_count: 5 } }),
    ).toEqual([])
    expect(detect({ name: "session.timeline.unmount", timeline_session_id: "session-1", data: {} })).toEqual([])
    expect(detect({ name: "session.timeline.mount", timeline_session_id: "session-1", data: {} })).toEqual([
      expect.objectContaining({
        name: "incident.session_timeline_remount",
        data: { timeline_mount_count: 2, timeline_unmount_count: 1 },
      }),
    ])
    expect(
      detect({ name: "session.timeline.visible", timeline_session_id: "session-1", data: { rendered_count: 0 } }),
    ).toEqual([])
    expect(
      detect({ name: "session.timeline.visible", timeline_session_id: "session-1", data: { rendered_count: 4 } }),
    ).toEqual([
      expect.objectContaining({
        name: "incident.session_visible_messages_cleared",
        data: { before_count: 5, during_count: 0, after_count: 4 },
      }),
    ])
  })

  test("does not flag an exit-worktree-like same-session refresh without remount, clear, or top jump", () => {
    const detect = createRendererIncidentDetector()

    expect(detect({ name: "session.timeline.mount", timeline_session_id: "session-1", data: {} })).toEqual([])
    expect(
      detect({ name: "session.timeline.visible", timeline_session_id: "session-1", data: { rendered_count: 80 } }),
    ).toEqual([])
    expect(
      detect({
        name: "session.scroll.sample",
        timeline_session_id: "session-1",
        data: { scroll_top: 20451, distance_from_bottom: 0, client_height: 720, user_scrolled: false },
      }),
    ).toEqual([])
    expect(
      detect({ name: "session.timeline.visible", timeline_session_id: "session-1", data: { rendered_count: 80 } }),
    ).toEqual([])
    expect(
      detect({
        name: "session.scroll.sample",
        timeline_session_id: "session-1",
        data: { scroll_top: 20440, distance_from_bottom: 12, client_height: 720, user_scrolled: false },
      }),
    ).toEqual([])
  })
})
