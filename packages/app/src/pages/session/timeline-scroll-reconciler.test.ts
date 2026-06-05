import { describe, expect, test } from "bun:test"
import type { TimelineSafePosition } from "./session-timeline-scroll-controller"
import { createTimelineScrollReconciler, type TimelineReconcilerDiagnostic } from "./timeline-scroll-reconciler"
import { createTimelineScrollCommandSink } from "./timeline-scroll-command-sink"

type RectInput = { top: number; bottom: number }

function stubRect(el: HTMLElement, rect: RectInput) {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ x: 0, y: rect.top, width: 720, height: rect.bottom - rect.top, top: rect.top, right: 720, bottom: rect.bottom, left: 0, toJSON: () => ({}) }),
  })
}

function makeViewport(input: { scrollTop: number; clientHeight: number; scrollHeight: number; rect?: RectInput }) {
  const viewport = document.createElement("div")
  let top = input.scrollTop
  let height = input.scrollHeight
  Object.defineProperties(viewport, {
    clientHeight: { value: input.clientHeight, configurable: true },
    scrollHeight: { configurable: true, get: () => height, set: (value) => { height = value } },
    scrollTop: { configurable: true, get: () => top, set: (value) => { top = value } },
  })
  stubRect(viewport, input.rect ?? { top: 0, bottom: input.clientHeight })
  return viewport
}

function appendMessage(viewport: HTMLElement, id: string, rect: RectInput) {
  const el = document.createElement("div")
  el.dataset.messageId = id
  stubRect(el, rect)
  viewport.appendChild(el)
  return el
}

/** A controllable frame scheduler: callbacks run only when `runFrame` is called. */
function makeFrameQueue() {
  const callbacks = new Map<number, () => void>()
  let nextHandle = 1
  return {
    scheduleFrame: (callback: () => void) => {
      const handle = nextHandle++
      callbacks.set(handle, callback)
      return handle
    },
    cancelFrame: (handle: number) => {
      callbacks.delete(handle)
    },
    runFrame: () => {
      const pending = [...callbacks.entries()]
      callbacks.clear()
      for (const [, callback] of pending) callback()
    },
    pendingCount: () => callbacks.size,
  }
}

function setup(input: {
  viewport: HTMLElement | undefined
  anchor: () => TimelineSafePosition
  requestReveal?: (position: TimelineSafePosition) => void
  revealBudget?: number
}) {
  const frames = makeFrameQueue()
  const sink = createTimelineScrollCommandSink({ now: () => 0 })
  const diagnostics: TimelineReconcilerDiagnostic[] = []
  const activeLog: boolean[] = []
  const reconciler = createTimelineScrollReconciler({
    viewport: () => input.viewport,
    scrollCommandSink: sink,
    resolveAnchor: input.anchor,
    requestReveal: input.requestReveal,
    scheduleFrame: frames.scheduleFrame,
    cancelFrame: frames.cancelFrame,
    setActive: (next) => activeLog.push(next),
    emitDiagnostic: (d) => diagnostics.push(d),
    revealBudget: input.revealBudget,
  })
  return { reconciler, frames, sink, diagnostics, activeLog }
}

describe("timeline scroll reconciler", () => {
  test("coalesces multiple markDirty into a single flush per frame", () => {
    const viewport = makeViewport({ scrollTop: 0, clientHeight: 400, scrollHeight: 1000 })
    const { reconciler, frames, sink } = setup({ viewport, anchor: () => ({ kind: "latest" }) })

    reconciler.markDirty("content-resize")
    reconciler.markDirty("content-resize")
    reconciler.markDirty("dock-resize")
    expect(frames.pendingCount()).toBe(1)

    frames.runFrame()
    expect(sink.records()).toHaveLength(1)
    expect(sink.records()[0]).toMatchObject({ type: "bottom-follow", top: 600 })
  })

  test("pins latest to the bottom (reads before writing, one command)", () => {
    const viewport = makeViewport({ scrollTop: 120, clientHeight: 400, scrollHeight: 1000 })
    const { reconciler, frames, sink } = setup({ viewport, anchor: () => ({ kind: "latest" }) })

    reconciler.markDirty("content-resize")
    frames.runFrame()
    expect(viewport.scrollTop).toBe(600)
    expect(sink.records()).toHaveLength(1)
  })

  test("skips the write when already within minDelta of the anchor", () => {
    const viewport = makeViewport({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })
    const { reconciler, frames, sink, diagnostics } = setup({ viewport, anchor: () => ({ kind: "latest" }) })

    reconciler.markDirty("content-resize")
    frames.runFrame()
    expect(sink.records()).toHaveLength(0)
    expect(diagnostics.at(-1)).toMatchObject({ outcome: "noop" })
  })

  test("requests reveal and retries while a reading anchor is unmounted, then settles when it mounts", () => {
    const viewport = makeViewport({ scrollTop: 400, clientHeight: 400, scrollHeight: 1400, rect: { top: 100, bottom: 500 } })
    const revealed: string[] = []
    const anchor: TimelineSafePosition = { kind: "reading", anchorMessageID: "msg_anchor", offsetFromViewportTop: 24, renderedStart: 0, renderedCount: 10 }
    const { reconciler, frames, sink } = setup({
      viewport,
      anchor: () => anchor,
      requestReveal: (p) => revealed.push(p.kind),
    })

    reconciler.markDirty("history-prepend")
    frames.runFrame() // anchor not mounted -> pending-reveal, retry scheduled
    expect(revealed).toEqual(["reading"])
    expect(sink.records()).toHaveLength(0)
    expect(reconciler.active()).toBe(true)
    expect(frames.pendingCount()).toBe(1)

    appendMessage(viewport, "msg_anchor", { top: 180, bottom: 300 })
    frames.runFrame() // now mounted -> pins
    expect(viewport.scrollTop).toBe(456)
    expect(reconciler.active()).toBe(false)
  })

  test("never falls back to latest: exhausts the reveal budget and keeps scrollTop", () => {
    const viewport = makeViewport({ scrollTop: 250, clientHeight: 400, scrollHeight: 1400 })
    const anchor: TimelineSafePosition = { kind: "reading", anchorMessageID: "msg_missing", offsetFromViewportTop: 0, renderedStart: 0, renderedCount: 10 }
    const { reconciler, frames, sink, diagnostics } = setup({ viewport, anchor: () => anchor, revealBudget: 2 })

    reconciler.markDirty("history-prepend")
    frames.runFrame() // attempt 1
    frames.runFrame() // attempt 2
    frames.runFrame() // budget spent -> exhausted
    expect(sink.records()).toHaveLength(0)
    expect(viewport.scrollTop).toBe(250)
    expect(diagnostics.at(-1)).toMatchObject({ outcome: "exhausted" })
    expect(reconciler.active()).toBe(false)
    expect(frames.pendingCount()).toBe(0)
  })

  test("withAnchorSnapshot re-pins to the pre-mutation anchor after a layout mutation", () => {
    const viewport = makeViewport({ scrollTop: 400, clientHeight: 400, scrollHeight: 1400, rect: { top: 100, bottom: 500 } })
    const anchorEl = appendMessage(viewport, "msg_anchor", { top: 156, bottom: 280 })
    // Anchor is 56px below the viewport top right now; snapshot should capture that offset.
    let anchor: TimelineSafePosition = { kind: "reading", anchorMessageID: "msg_anchor", offsetFromViewportTop: 56, renderedStart: 0, renderedCount: 10 }
    const { reconciler, frames } = setup({ viewport, anchor: () => anchor })

    reconciler.withAnchorSnapshot("history-prepend", () => {
      // Simulate prepend pushing the anchor down by 200px (content added above).
      stubRect(anchorEl, { top: 356, bottom: 480 })
      // resolveAnchor would now sample a different position; snapshot must win.
      anchor = { kind: "latest" }
    })
    frames.runFrame()
    // Re-pin keeps the captured anchor at offset 56: scrollTop += (356 - 100) - 56 = 600 - 100 = 600
    expect(viewport.scrollTop).toBe(600)
  })

  test("cancel() drops a pending flush via the generation guard", () => {
    const viewport = makeViewport({ scrollTop: 0, clientHeight: 400, scrollHeight: 1000 })
    const { reconciler, frames, sink } = setup({ viewport, anchor: () => ({ kind: "latest" }) })

    reconciler.markDirty("content-resize")
    reconciler.cancel()
    frames.runFrame()
    expect(sink.records()).toHaveLength(0)
    expect(reconciler.active()).toBe(false)
  })
})
