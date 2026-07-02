import { describe, expect, test } from "bun:test"
import {
  classifyTimelineScrollGesture,
  createSessionTimelineScrollController,
  type TimelineSafePosition,
  type TimelineScrollDiagnosticEvent,
  type TimelineScrollMetrics,
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
  test("submit follows the latest output", () => {
    const { controller } = makeController()
    const result = controller.intent({ type: "submit", originMode: "reading_history" })
    expect(result).toEqual({ accepted: true, mode: "following_latest", anchorChanged: true, reason: "submit_follow_latest" })
    expect(controller.state().lastSafePosition).toEqual({ kind: "latest" })
  })

  test("a weak upward gesture leaves follow mode immediately (the RCA fix)", () => {
    const { controller } = makeController()
    controller.intent({ type: "submit", originMode: "following_latest" })

    const result = controller.intent({
      type: "wheel_scroll",
      source: "timeline",
      direction: "up",
      strength: "weak",
      nestedScrollable: false,
    })

    expect(result.mode).toBe("reading_history")
    expect(result.reason).toBe("user_upward_navigation")
  })

  test("submit followed by an upward scroll stays in reading and is never restored to latest", () => {
    const { controller, diagnostics } = makeController()
    controller.observe({ type: "scroll_sample", metrics: bottomMetrics, safePosition: { kind: "latest" } })
    controller.intent({ type: "submit", originMode: "following_latest" })
    controller.intent({ type: "wheel_scroll", source: "timeline", direction: "up", strength: "weak", nestedScrollable: false })

    const result = controller.observe({ type: "scroll_sample", metrics: topMetrics, safePosition: readingAnchor })

    expect(result.mode).toBe("reading_history")
    expect(controller.state().lastSafePosition).toEqual(readingAnchor)
    expect(diagnostics.some((event) => event.data.reason === "reading_anchor_sampled")).toBe(true)
    // The old "submit_restore_latest_after_top_reset" recovery must no longer exist.
    expect(diagnostics.some((event) => String(event.data.reason).includes("restore_latest"))).toBe(false)
  })

  test("reaching the bottom resumes following the latest", () => {
    const { controller } = makeController()
    controller.intent({ type: "wheel_scroll", source: "timeline", direction: "up", strength: "strong", nestedScrollable: false })
    expect(controller.state().mode).toBe("reading_history")

    const result = controller.observe({ type: "scroll_sample", metrics: bottomMetrics })
    expect(result.mode).toBe("following_latest")
    expect(result.reason).toBe("reached_bottom_follow_latest")
    expect(controller.state().lastSafePosition).toEqual({ kind: "latest" })
  })

  test("samples the reading anchor on a mid-timeline scroll while reading", () => {
    const { controller } = makeController()
    controller.intent({ type: "keyboard_scroll", key: "ArrowUp", source: "scroll_view" })

    controller.observe({ type: "scroll_sample", metrics: middleMetrics, safePosition: readingAnchor })
    expect(controller.state().lastSafePosition).toEqual(readingAnchor)
    expect(controller.state().mode).toBe("reading_history")
  })

  test("target message navigation targets the requested message", () => {
    const { controller } = makeController()
    const result = controller.intent({ type: "target_message", messageID: "msg_target", align: "nearest" })
    expect(result.mode).toBe("targeting_message")
    expect(controller.state().lastSafePosition).toEqual({
      kind: "target_message",
      messageID: "msg_target",
      align: "nearest",
      loadPolicy: "load_until_visible",
    })
  })

  test("targeting is not overwritten by a non-bottom scroll sample", () => {
    const { controller } = makeController()
    controller.intent({ type: "target_message", messageID: "msg_target", align: "nearest" })
    controller.observe({ type: "scroll_sample", metrics: middleMetrics, safePosition: readingAnchor })
    expect(controller.state().lastSafePosition).toMatchObject({ kind: "target_message", messageID: "msg_target" })
  })

  test("detach reports owner match", () => {
    const { controller } = makeController()
    expect(controller.detach({ sessionOwner: "ses_1", viewportOwner: "viewport_1" }).accepted).toBe(true)
    expect(controller.detach({ sessionOwner: "other", viewportOwner: "viewport_1" }).accepted).toBe(false)
  })

  test("classifies gesture strength against the viewport ratio threshold", () => {
    expect(classifyTimelineScrollGesture({ deltaY: -40, viewportHeight: 800, nestedScrollable: false, atNestedBoundary: false })).toEqual({
      direction: "up",
      strength: "weak",
      nestedScrollable: false,
    })
    expect(classifyTimelineScrollGesture({ deltaY: 240, viewportHeight: 800, nestedScrollable: true, atNestedBoundary: false })).toEqual({
      direction: "down",
      strength: "strong",
      nestedScrollable: true,
    })
  })
})
