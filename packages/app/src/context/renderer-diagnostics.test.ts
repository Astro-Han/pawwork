import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createRendererDiagnosticsEmitter, createSessionPerformanceDiagnostics } from "./renderer-diagnostics"
import type { RendererDiagnosticInput } from "./platform"

describe("renderer diagnostics", () => {
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
})
