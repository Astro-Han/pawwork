import { describe, expect, test } from "bun:test"
import {
  collectTimelineScrollMetrics,
  restoreTimelineSafePosition,
  sampleTimelineSafePosition,
} from "./session-timeline-scroll-anchors"
import { createTimelineScrollCommandSink } from "./timeline-scroll-command-sink"

type RectInput = {
  top: number
  bottom: number
}

function stubRect(el: HTMLElement, rect: RectInput) {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: rect.top,
      width: 720,
      height: rect.bottom - rect.top,
      top: rect.top,
      right: 720,
      bottom: rect.bottom,
      left: 0,
      toJSON: () => ({}),
    }),
  })
}

function makeViewport(input: { scrollTop: number; clientHeight: number; scrollHeight: number; rect?: RectInput }) {
  const viewport = document.createElement("div")
  let top = input.scrollTop
  let height = input.scrollHeight

  Object.defineProperties(viewport, {
    clientHeight: { value: input.clientHeight, configurable: true },
    scrollHeight: {
      configurable: true,
      get: () => height,
      set: (value) => {
        height = value
      },
    },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value) => {
        top = value
      },
    },
  })
  stubRect(viewport, input.rect ?? { top: 100, bottom: 100 + input.clientHeight })

  return {
    viewport,
    get scrollTop() {
      return top
    },
  }
}

function appendMessage(viewport: HTMLElement, id: string, rect: RectInput) {
  const message = document.createElement("div")
  message.dataset.messageId = id
  stubRect(message, rect)
  viewport.appendChild(message)
  return message
}

describe("session timeline scroll anchors", () => {
  test("collects near-top and near-bottom metrics from explicit geometry", () => {
    const { viewport } = makeViewport({
      scrollTop: 398,
      clientHeight: 400,
      scrollHeight: 800,
    })

    expect(collectTimelineScrollMetrics(viewport)).toEqual({
      scrollTop: 398,
      scrollHeight: 800,
      clientHeight: 400,
      distanceFromTop: 398,
      distanceFromBottom: 2,
      nearTop: false,
      nearBottom: true,
    })
  })

  test("samples latest with newest message id in following mode", () => {
    const { viewport } = makeViewport({
      scrollTop: 400,
      clientHeight: 400,
      scrollHeight: 800,
    })

    expect(
      sampleTimelineSafePosition({
        viewport,
        mode: "following_latest",
        renderedStart: 20,
        renderedCount: 10,
        newestMessageID: "msg_29",
      }),
    ).toEqual({ kind: "latest", messageID: "msg_29" })
  })

  test("samples first visible message as a reading anchor", () => {
    const { viewport } = makeViewport({
      scrollTop: 260,
      clientHeight: 400,
      scrollHeight: 1200,
      rect: { top: 100, bottom: 500 },
    })
    appendMessage(viewport, "msg_above", { top: -100, bottom: 50 })
    appendMessage(viewport, "msg_anchor", { top: 124, bottom: 240 })
    appendMessage(viewport, "msg_next", { top: 260, bottom: 420 })

    expect(
      sampleTimelineSafePosition({
        viewport,
        mode: "reading_history",
        renderedStart: 4,
        renderedCount: 10,
        newestMessageID: "msg_newest",
      }),
    ).toEqual({
      kind: "reading",
      anchorMessageID: "msg_anchor",
      offsetFromViewportTop: 24,
      renderedStart: 4,
      renderedCount: 10,
    })
  })

  test("keeps target message as the sampled anchor while targeting", () => {
    const { viewport } = makeViewport({
      scrollTop: 260,
      clientHeight: 400,
      scrollHeight: 1200,
    })
    appendMessage(viewport, "msg_anchor", { top: 124, bottom: 240 })

    expect(
      sampleTimelineSafePosition({
        viewport,
        mode: "targeting_message",
        renderedStart: 4,
        renderedCount: 10,
        newestMessageID: "msg_newest",
        targetMessageID: "msg_target",
      }),
    ).toEqual({
      kind: "target_message",
      messageID: "msg_target",
      align: "nearest",
      loadPolicy: "load_until_visible",
    })
  })

  test("restores latest to bottom without sentinel", () => {
    const scroller = makeViewport({
      scrollTop: 120,
      clientHeight: 400,
      scrollHeight: 1000,
    })
    const scrollCommandSink = createTimelineScrollCommandSink({ now: () => 200 })

    expect(
      restoreTimelineSafePosition({
        viewport: scroller.viewport,
        position: { kind: "latest", messageID: "msg_latest" },
        scrollCommandSink,
      }),
    ).toEqual({ ok: true, restoredTo: { kind: "latest", messageID: "msg_latest" } })
    expect(scroller.scrollTop).toBe(600)
    expect(scrollCommandSink.records()).toEqual([
      expect.objectContaining({
        monotonicMs: 200,
        type: "anchor-restore",
        source: "session-timeline-scroll-anchors/restoreLatest",
        reason: "scroll-height-bottom",
        top: 600,
      }),
    ])
  })

  test("restores reading anchor to its previous viewport offset", () => {
    const scroller = makeViewport({
      scrollTop: 400,
      clientHeight: 400,
      scrollHeight: 1400,
      rect: { top: 100, bottom: 500 },
    })
    appendMessage(scroller.viewport, "msg_anchor", { top: 180, bottom: 300 })

    expect(
      restoreTimelineSafePosition({
        viewport: scroller.viewport,
        position: {
          kind: "reading",
          anchorMessageID: "msg_anchor",
          offsetFromViewportTop: 24,
          renderedStart: 4,
          renderedCount: 10,
        },
      }),
    ).toEqual({
      ok: true,
      restoredTo: {
        kind: "reading",
        anchorMessageID: "msg_anchor",
        offsetFromViewportTop: 24,
        renderedStart: 4,
        renderedCount: 10,
      },
    })
    expect(scroller.scrollTop).toBe(456)
  })

  test("restores nearest target only when it is outside the viewport", () => {
    const scroller = makeViewport({
      scrollTop: 100,
      clientHeight: 400,
      scrollHeight: 1200,
      rect: { top: 100, bottom: 500 },
    })
    appendMessage(scroller.viewport, "msg_visible", { top: 160, bottom: 260 })
    appendMessage(scroller.viewport, "msg_below", { top: 540, bottom: 700 })

    expect(
      restoreTimelineSafePosition({
        viewport: scroller.viewport,
        position: {
          kind: "target_message",
          messageID: "msg_visible",
          align: "nearest",
          loadPolicy: "load_until_visible",
        },
      }),
    ).toEqual({
      ok: true,
      restoredTo: {
        kind: "target_message",
        messageID: "msg_visible",
        align: "nearest",
        loadPolicy: "load_until_visible",
      },
    })
    expect(scroller.scrollTop).toBe(100)

    restoreTimelineSafePosition({
      viewport: scroller.viewport,
      position: {
        kind: "target_message",
        messageID: "msg_below",
        align: "nearest",
        loadPolicy: "load_until_visible",
      },
    })
    expect(scroller.scrollTop).toBe(300)
  })

  test("returns a typed failure when an anchor is not mounted", () => {
    const { viewport } = makeViewport({
      scrollTop: 100,
      clientHeight: 400,
      scrollHeight: 1200,
    })

    expect(
      restoreTimelineSafePosition({
        viewport,
        position: {
          kind: "reading",
          anchorMessageID: "msg_missing",
          offsetFromViewportTop: 0,
          renderedStart: 0,
          renderedCount: 10,
        },
      }),
    ).toEqual({ ok: false, reason: "anchor_not_mounted" })
  })
})
