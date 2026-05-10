import { describe, expect, test } from "bun:test"
import {
  createSessionTimelineScrollController,
  createTimelineScrollControllerDiagnostic,
  type TimelineScrollDiagnosticEvent,
  type TimelineScrollMetrics,
  type TimelineSafePosition,
} from "./session-timeline-scroll-controller"

const bottomMetrics: TimelineScrollMetrics = {
  scrollTop: 853,
  scrollHeight: 1674,
  clientHeight: 821,
  distanceFromTop: 853,
  distanceFromBottom: 0,
  nearTop: false,
  nearBottom: true,
}

const topMetrics: TimelineScrollMetrics = {
  scrollTop: 6,
  scrollHeight: 1674,
  clientHeight: 821,
  distanceFromTop: 6,
  distanceFromBottom: 847,
  nearTop: true,
  nearBottom: false,
}

const middleMetrics: TimelineScrollMetrics = {
  scrollTop: 420,
  scrollHeight: 1674,
  clientHeight: 821,
  distanceFromTop: 420,
  distanceFromBottom: 433,
  nearTop: false,
  nearBottom: false,
}

const readingAnchor: TimelineSafePosition = {
  kind: "reading",
  anchorMessageID: "msg_anchor",
  offsetFromViewportTop: 24,
  renderedStart: 4,
  renderedCount: 10,
}

function makeController() {
  const diagnostics: TimelineScrollDiagnosticEvent[] = []
  const controller = createSessionTimelineScrollController({
    sessionOwner: "ses_1",
    viewportOwner: "viewport_1",
    routeSessionID: "ses_1",
    visibleSessionID: "ses_1",
    timelineSessionID: "ses_1",
    emitDiagnostic: (event) => diagnostics.push(event),
  })
  return { controller, diagnostics }
}

describe("session timeline scroll controller", () => {
  test("restores latest when submit is followed by an observation-only top reset", () => {
    const { controller, diagnostics } = makeController()

    controller.observe({
      type: "scroll_sample",
      metrics: bottomMetrics,
      safePosition: { kind: "latest", messageID: "msg_latest" },
    })

    controller.intent({
      type: "submit",
      originMode: "following_latest",
    })

    const result = controller.observe({
      type: "scroll_sample",
      metrics: topMetrics,
    })

    expect(result).toEqual({
      accepted: false,
      recovery: {
        type: "restore_latest",
        reason: "submit_restore_latest_after_top_reset",
      },
      reason: "submit_restore_latest_after_top_reset",
    })
    expect(controller.state().mode).toBe("following_latest")
    expect(diagnostics.at(-1)).toMatchObject({
      name: "session.timeline.scroll_controller",
      data: {
        accepted: false,
        recovery: true,
        reason: "submit_restore_latest_after_top_reset",
        mode_before: "following_latest",
        mode_after: "following_latest",
        observation_type: "scroll_sample",
        near_top: true,
        near_bottom: false,
        submit_origin_mode: "following_latest",
      },
    })
  })

  test("accepts explicit Home navigation to history instead of restoring latest", () => {
    const { controller } = makeController()

    controller.intent({
      type: "submit",
      originMode: "following_latest",
    })
    const intentResult = controller.intent({
      type: "keyboard_scroll",
      key: "Home",
      source: "scroll_view",
    })
    const scrollResult = controller.observe({
      type: "scroll_sample",
      metrics: topMetrics,
      safePosition: readingAnchor,
    })

    expect(intentResult.reason).toBe("explicit_top_navigation")
    expect(scrollResult.accepted).toBe(true)
    expect(scrollResult.recovery).toEqual({ type: "none" })
    expect(controller.state().mode).toBe("reading_history")
    expect(controller.state().lastSafePosition).toEqual(readingAnchor)
  })

  test("strong upward wheel intent can leave latest", () => {
    const { controller } = makeController()

    const result = controller.intent({
      type: "wheel_scroll",
      source: "timeline",
      direction: "up",
      strength: "strong",
      nestedScrollable: false,
    })

    expect(result.reason).toBe("strong_upward_navigation")
    expect(controller.state().mode).toBe("reading_history")
  })

  test("weak upward wheel intent does not leave latest", () => {
    const { controller } = makeController()

    const result = controller.intent({
      type: "wheel_scroll",
      source: "timeline",
      direction: "up",
      strength: "weak",
      nestedScrollable: false,
    })

    expect(result.reason).toBe("weak_scroll_observed")
    expect(controller.state().mode).toBe("following_latest")
  })

  test("explicit bottom navigation rejoins latest from reading", () => {
    const { controller } = makeController()

    controller.intent({
      type: "keyboard_scroll",
      key: "PageUp",
      source: "scroll_view",
    })
    controller.observe({
      type: "scroll_sample",
      metrics: middleMetrics,
      safePosition: readingAnchor,
    })

    const result = controller.intent({
      type: "scrollbar_drag_end",
      source: "scroll_view",
      metrics: bottomMetrics,
    })

    expect(result.reason).toBe("explicit_bottom_navigation")
    expect(controller.state().mode).toBe("following_latest")
    expect(controller.state().lastSafePosition).toEqual({ kind: "latest" })
  })

  test("reading anchor is restored for after-layout resize observations", () => {
    const { controller } = makeController()

    controller.intent({
      type: "keyboard_scroll",
      key: "PageUp",
      source: "scroll_view",
    })
    controller.observe({
      type: "scroll_sample",
      metrics: middleMetrics,
      safePosition: readingAnchor,
    })

    const result = controller.observe({
      type: "content_resize",
      metrics: middleMetrics,
    })

    expect(result).toEqual({
      accepted: true,
      recovery: {
        type: "restore_anchor",
        reason: "content_resize_preserve_reading",
        anchor: readingAnchor,
      },
      reason: "content_resize_preserve_reading",
    })
    expect(controller.state().mode).toBe("reading_history")
  })

  test("target message remains the recovery anchor across window changes", () => {
    const { controller } = makeController()

    controller.intent({
      type: "target_message",
      messageID: "msg_target",
      align: "nearest",
    })

    const result = controller.observe({
      type: "window_changed",
      renderedStart: 0,
      renderedCount: 20,
      metrics: middleMetrics,
    })

    expect(result).toEqual({
      accepted: true,
      recovery: {
        type: "restore_anchor",
        reason: "window_changed_preserve_target",
        anchor: {
          kind: "target_message",
          messageID: "msg_target",
          align: "nearest",
          loadPolicy: "load_until_visible",
        },
      },
      reason: "window_changed_preserve_target",
    })
    expect(controller.state().mode).toBe("targeting_message")
  })

  test("owner detach cancels pending recovery", () => {
    const { controller, diagnostics } = makeController()

    controller.intent({
      type: "submit",
      originMode: "following_latest",
    })

    const result = controller.detach({
      sessionOwner: "old_ses",
      viewportOwner: "old_viewport",
    })

    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("owner_mismatch_cancelled")
    expect(controller.state().pendingRecovery).toEqual({ type: "none" })
    expect(diagnostics.at(-1)).toMatchObject({
      data: {
        accepted: false,
        reason: "owner_mismatch_cancelled",
      },
    })
  })

  test("diagnostic builder uses the existing renderer diagnostic shape", () => {
    const event = createTimelineScrollControllerDiagnostic({
      routeSessionID: "route",
      visibleSessionID: "visible",
      timelineSessionID: "timeline",
      data: {
        mode_before: "following_latest",
        mode_after: "following_latest",
        accepted: false,
        recovery: true,
        reason: "submit_restore_latest_after_top_reset",
        session_owner: "ses_1",
        viewport_owner: "viewport_1",
      },
    })

    expect(event).toEqual({
      name: "session.timeline.scroll_controller",
      route_session_id: "route",
      visible_session_id: "visible",
      timeline_session_id: "timeline",
      data: {
        mode_before: "following_latest",
        mode_after: "following_latest",
        accepted: false,
        recovery: true,
        reason: "submit_restore_latest_after_top_reset",
        session_owner: "ses_1",
        viewport_owner: "viewport_1",
      },
    })
  })
})
