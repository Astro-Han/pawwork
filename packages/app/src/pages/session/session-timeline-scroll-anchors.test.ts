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

function appendTimelineAnchor(parent: HTMLElement, key: string, rect: RectInput) {
  const anchor = document.createElement("div")
  anchor.dataset.timelineAnchor = key
  stubRect(anchor, rect)
  parent.appendChild(anchor)
  return anchor
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

  test("samples the visible timeline anchor nearest the viewport reading line before the message row", () => {
    const { viewport } = makeViewport({
      scrollTop: 260,
      clientHeight: 400,
      scrollHeight: 1600,
      rect: { top: 100, bottom: 500 },
    })
    const message = appendMessage(viewport, "msg_anchor", { top: 100, bottom: 900 })
    appendTimelineAnchor(message, "tool:above", { top: 104, bottom: 140 })
    appendTimelineAnchor(message, "trow:stable", { top: 188, bottom: 260 })
    appendTimelineAnchor(message, "tool:below", { top: 360, bottom: 460 })

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
      offsetFromViewportTop: 88,
      renderedStart: 4,
      renderedCount: 10,
      primaryAnchor: {
        key: "trow:stable",
        offsetFromViewportTop: 88,
        scope: "trow",
      },
      fallbackMessage: {
        messageID: "msg_anchor",
        offsetFromViewportTop: 0,
      },
    })
  })

  test("ignores hidden or edge-only timeline anchors while sampling reading position", () => {
    const { viewport } = makeViewport({
      scrollTop: 260,
      clientHeight: 400,
      scrollHeight: 1600,
      rect: { top: 100, bottom: 500 },
    })
    const message = appendMessage(viewport, "msg_anchor", { top: 80, bottom: 900 })
    appendTimelineAnchor(message, "tool:edge", { top: 499.5, bottom: 500 })
    appendTimelineAnchor(message, "tool:zero", { top: 220, bottom: 220 })
    const hidden = appendTimelineAnchor(message, "tool:hidden", { top: 180, bottom: 230 })
    hidden.hidden = true
    appendTimelineAnchor(message, "tool:visible", { top: 240, bottom: 300 })

    expect(
      sampleTimelineSafePosition({
        viewport,
        mode: "reading_history",
        renderedStart: 4,
        renderedCount: 10,
        newestMessageID: "msg_newest",
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "reading",
        anchorMessageID: "msg_anchor",
        primaryAnchor: expect.objectContaining({ key: "tool:visible", scope: "tool" }),
      }),
    )
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

  test("restores reading position using the primary timeline anchor before the message row", () => {
    const scroller = makeViewport({
      scrollTop: 400,
      clientHeight: 400,
      scrollHeight: 1400,
      rect: { top: 100, bottom: 500 },
    })
    const message = appendMessage(scroller.viewport, "msg_anchor", { top: 160, bottom: 700 })
    appendTimelineAnchor(message, "tool:part:1", { top: 220, bottom: 320 })

    expect(
      restoreTimelineSafePosition({
        viewport: scroller.viewport,
        position: {
          kind: "reading",
          anchorMessageID: "msg_anchor",
          offsetFromViewportTop: 0,
          renderedStart: 4,
          renderedCount: 10,
          primaryAnchor: {
            key: "tool:part:1",
            offsetFromViewportTop: 72,
            scope: "tool",
          },
          fallbackMessage: {
            messageID: "msg_anchor",
            offsetFromViewportTop: 24,
          },
        },
      }),
    ).toEqual({
      ok: true,
      restoredTo: expect.objectContaining({
        kind: "reading",
        primaryAnchor: expect.objectContaining({ key: "tool:part:1" }),
      }),
    })
    expect(scroller.scrollTop).toBe(448)
  })

  test("falls back to the message row when the primary timeline anchor disappeared", () => {
    const scroller = makeViewport({
      scrollTop: 400,
      clientHeight: 400,
      scrollHeight: 1400,
      rect: { top: 100, bottom: 500 },
    })
    appendMessage(scroller.viewport, "msg_anchor", { top: 180, bottom: 700 })

    expect(
      restoreTimelineSafePosition({
        viewport: scroller.viewport,
        position: {
          kind: "reading",
          anchorMessageID: "msg_anchor",
          offsetFromViewportTop: 0,
          renderedStart: 4,
          renderedCount: 10,
          primaryAnchor: {
            key: "tool:part:missing",
            offsetFromViewportTop: 72,
            scope: "tool",
          },
          fallbackMessage: {
            messageID: "msg_anchor",
            offsetFromViewportTop: 24,
          },
        },
      }),
    ).toEqual({
      ok: true,
      restoredTo: expect.objectContaining({ kind: "reading" }),
    })
    expect(scroller.scrollTop).toBe(456)
  })

  test("falls back to the trow anchor when a tool anchor disappears and the message row is re-keyed", () => {
    const scroller = makeViewport({
      scrollTop: 400,
      clientHeight: 400,
      scrollHeight: 1400,
      rect: { top: 100, bottom: 500 },
    })
    const message = appendMessage(scroller.viewport, "msg_replaced", { top: 180, bottom: 700 })
    appendTimelineAnchor(message, "trow:stable", { top: 210, bottom: 260 })

    expect(
      restoreTimelineSafePosition({
        viewport: scroller.viewport,
        position: {
          kind: "reading",
          anchorMessageID: "msg_placeholder",
          offsetFromViewportTop: 0,
          renderedStart: 4,
          renderedCount: 10,
          primaryAnchor: {
            key: "tool:old-key",
            offsetFromViewportTop: 72,
            scope: "tool",
          },
          fallbackTrowAnchor: {
            key: "trow:stable",
            offsetFromViewportTop: 88,
            scope: "trow",
          },
          fallbackMessage: {
            messageID: "msg_placeholder",
            offsetFromViewportTop: 24,
          },
        },
      }),
    ).toEqual({
      ok: true,
      restoredTo: expect.objectContaining({
        kind: "reading",
        fallbackTrowAnchor: expect.objectContaining({ key: "trow:stable" }),
      }),
    })
    expect(scroller.scrollTop).toBe(422)
  })

  test.each([
    ["hidden", (anchor: HTMLElement) => void (anchor.hidden = true)],
    ["zero-size", (anchor: HTMLElement) => stubRect(anchor, { top: 220, bottom: 220 })],
    [
      "inside closed details",
      (anchor: HTMLElement) => {
        const details = document.createElement("details")
        anchor.replaceWith(details)
        details.appendChild(anchor)
      },
    ],
  ])("skips a %s primary tool anchor and restores with the fallback trow anchor", (_, hidePrimary) => {
    const scroller = makeViewport({
      scrollTop: 400,
      clientHeight: 400,
      scrollHeight: 1400,
      rect: { top: 100, bottom: 500 },
    })
    const message = appendMessage(scroller.viewport, "msg_anchor", { top: 180, bottom: 700 })
    const primary = appendTimelineAnchor(message, "tool:hidden-primary", { top: 360, bottom: 420 })
    appendTimelineAnchor(message, "trow:stable", { top: 210, bottom: 260 })
    hidePrimary(primary)

    expect(
      restoreTimelineSafePosition({
        viewport: scroller.viewport,
        position: {
          kind: "reading",
          anchorMessageID: "msg_anchor",
          offsetFromViewportTop: 0,
          renderedStart: 4,
          renderedCount: 10,
          primaryAnchor: {
            key: "tool:hidden-primary",
            offsetFromViewportTop: 72,
            scope: "tool",
          },
          fallbackTrowAnchor: {
            key: "trow:stable",
            offsetFromViewportTop: 88,
            scope: "trow",
          },
          fallbackMessage: {
            messageID: "msg_anchor",
            offsetFromViewportTop: 24,
          },
        },
      }),
    ).toEqual({
      ok: true,
      restoredTo: expect.objectContaining({ kind: "reading" }),
    })
    expect(scroller.scrollTop).toBe(422)
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
