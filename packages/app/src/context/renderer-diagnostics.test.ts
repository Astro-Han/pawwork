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
  const originalApi = window.api

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame
    window.api = originalApi
  })

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

  test("detects timeline remounts and recovered visible message clears", () => {
    const detect = createRendererIncidentDetector()

    expect(detect({ name: "session.timeline.mount", timeline_session_id: "session-1", data: {} })).toEqual([])
    expect(detect({ name: "session.timeline.visible", timeline_session_id: "session-1", data: { rendered_count: 5 } })).toEqual(
      [],
    )
    expect(detect({ name: "session.timeline.unmount", timeline_session_id: "session-1", data: {} })).toEqual([])
    expect(detect({ name: "session.timeline.mount", timeline_session_id: "session-1", data: {} })).toEqual([
      expect.objectContaining({
        name: "incident.session_timeline_remount",
        data: { timeline_mount_count: 2, timeline_unmount_count: 1 },
      }),
    ])
    expect(detect({ name: "session.timeline.visible", timeline_session_id: "session-1", data: { rendered_count: 0 } })).toEqual([])
    expect(detect({ name: "session.timeline.visible", timeline_session_id: "session-1", data: { rendered_count: 4 } })).toEqual([
      expect.objectContaining({
        name: "incident.session_visible_messages_cleared",
        data: { before_count: 5, during_count: 0, after_count: 4 },
      }),
    ])
  })

  test("does not flag an exit-worktree-like same-session refresh without remount, clear, or top jump", () => {
    const detect = createRendererIncidentDetector()

    expect(detect({ name: "session.timeline.mount", timeline_session_id: "session-1", data: {} })).toEqual([])
    expect(detect({ name: "session.timeline.visible", timeline_session_id: "session-1", data: { rendered_count: 80 } })).toEqual(
      [],
    )
    expect(
      detect({
        name: "session.scroll.sample",
        timeline_session_id: "session-1",
        data: { scroll_top: 20451, distance_from_bottom: 0, client_height: 720, user_scrolled: false },
      }),
    ).toEqual([])
    expect(detect({ name: "session.timeline.visible", timeline_session_id: "session-1", data: { rendered_count: 80 } })).toEqual(
      [],
    )
    expect(
      detect({
        name: "session.scroll.sample",
        timeline_session_id: "session-1",
        data: { scroll_top: 20440, distance_from_bottom: 12, client_height: 720, user_scrolled: false },
      }),
    ).toEqual([])
  })
})
