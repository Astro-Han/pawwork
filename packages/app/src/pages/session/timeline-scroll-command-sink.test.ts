import { describe, expect, test } from "bun:test"
import { createTimelineScrollCommandSink } from "./timeline-scroll-command-sink"

function makeScroller(input: { clientHeight: number; scrollHeight: number; scrollTop: number }) {
  const el = document.createElement("div")
  let top = input.scrollTop
  const scrollToCalls: Array<{ top: number; behavior?: ScrollBehavior }> = []

  Object.defineProperties(el, {
    clientHeight: { value: input.clientHeight, configurable: true },
    scrollHeight: { value: input.scrollHeight, configurable: true },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value) => {
        top = value
      },
    },
    scrollTo: {
      value: (options: ScrollToOptions) => {
        scrollToCalls.push({ top: Number(options.top ?? 0), behavior: options.behavior })
        top = Number(options.top ?? 0)
      },
      configurable: true,
    },
  })

  return { el, scrollToCalls, top: () => top }
}

describe("TimelineScrollCommandSink", () => {
  test("records and executes direct scrollTop commands", () => {
    const scroller = makeScroller({ clientHeight: 100, scrollHeight: 900, scrollTop: 12 })
    const sink = createTimelineScrollCommandSink({ now: () => 123 })

    sink.setScrollTop({
      element: scroller.el,
      top: 345,
      type: "anchor-restore",
      source: "session-timeline-scroll-anchors/restoreReading",
      reason: "reading-anchor",
    })

    expect(scroller.top()).toBe(345)
    expect(sink.records()).toEqual([
      expect.objectContaining({
        monotonicMs: 123,
        type: "anchor-restore",
        source: "session-timeline-scroll-anchors/restoreReading",
        reason: "reading-anchor",
        method: "set-scroll-top",
        top: 345,
      }),
    ])
  })

  test("uses scrollTo when behavior must be preserved", () => {
    const scroller = makeScroller({ clientHeight: 100, scrollHeight: 900, scrollTop: 12 })
    const sink = createTimelineScrollCommandSink()

    sink.scrollTo({
      element: scroller.el,
      top: 200,
      behavior: "smooth",
      type: "hash-target",
      source: "use-session-hash-scroll-core/scrollToElement",
    })

    expect(scroller.scrollToCalls).toEqual([{ top: 200, behavior: "smooth" }])
    expect(scroller.top()).toBe(200)
    expect(sink.records()[0]).toMatchObject({
      method: "scroll-to",
      behavior: "smooth",
      type: "hash-target",
    })
  })

  test("keeps full before and after metrics behind explicit enablement", () => {
    const scroller = makeScroller({ clientHeight: 100, scrollHeight: 900, scrollTop: 12 })
    const cheap = createTimelineScrollCommandSink({ fullMetricsEnabled: () => false })
    const full = createTimelineScrollCommandSink({ fullMetricsEnabled: () => true })

    cheap.setScrollTop({ element: scroller.el, top: 300, type: "bottom-follow", source: "cheap" })
    full.setScrollTop({ element: scroller.el, top: 400, type: "bottom-follow", source: "full" })

    expect(cheap.records()[0]?.before).toBeUndefined()
    expect(cheap.records()[0]?.after).toBeUndefined()
    expect(full.records()[0]?.before).toMatchObject({ scrollTop: 300, clientHeight: 100, scrollHeight: 900 })
    expect(full.records()[0]?.after).toMatchObject({ scrollTop: 400, clientHeight: 100, scrollHeight: 900 })
  })

  test("bounds retained command records", () => {
    const scroller = makeScroller({ clientHeight: 100, scrollHeight: 900, scrollTop: 0 })
    const sink = createTimelineScrollCommandSink({ maxRecords: 2 })

    sink.setScrollTop({ element: scroller.el, top: 1, type: "bottom-follow", source: "one" })
    sink.setScrollTop({ element: scroller.el, top: 2, type: "bottom-follow", source: "two" })
    sink.setScrollTop({ element: scroller.el, top: 3, type: "bottom-follow", source: "three" })

    expect(sink.records().map((record) => record.source)).toEqual(["two", "three"])
  })

  test("records transaction metadata on scoped commands", () => {
    const scroller = makeScroller({ clientHeight: 100, scrollHeight: 900, scrollTop: 12 })
    const sink = createTimelineScrollCommandSink({ now: () => 456 })
    const scoped = sink.withTransaction({ transactionID: "tx-1", transactionKind: "dock-resize" })

    scoped.setScrollTop({ element: scroller.el, top: 120, type: "anchor-restore", source: "transaction-test" })

    expect(sink.records()[0]).toMatchObject({
      transactionID: "tx-1",
      transactionKind: "dock-resize",
      type: "anchor-restore",
      source: "transaction-test",
    })
  })

  test("emits a transaction violation when an unscoped command runs during an active transaction", () => {
    const events: unknown[] = []
    const scroller = makeScroller({ clientHeight: 100, scrollHeight: 900, scrollTop: 12 })
    const sink = createTimelineScrollCommandSink({
      activeTransaction: () => ({ transactionID: "tx-2", transactionKind: "content-resize" }),
      emitDiagnostic: (event) => {
        events.push(event)
      },
    })

    sink.setScrollTop({ element: scroller.el, top: 220, type: "bottom-follow", source: "legacy-bottom-follow" })

    expect(events).toContainEqual(
      expect.objectContaining({
        name: "session.timeline.layout_transaction_violation",
        data: expect.objectContaining({
          transaction_id: "tx-2",
          transaction_kind: "content-resize",
          violation: "scroll_command_outside_transaction",
          command_source: "legacy-bottom-follow",
        }),
      }),
    )
  })

  test("keeps diagnostic failures out of the scroll path", async () => {
    const scroller = makeScroller({ clientHeight: 100, scrollHeight: 900, scrollTop: 0 })
    const syncSink = createTimelineScrollCommandSink({
      emitDiagnostic: () => {
        throw new Error("diagnostic sync failure")
      },
    })
    const asyncSink = createTimelineScrollCommandSink({
      emitDiagnostic: () => Promise.reject(new Error("diagnostic async failure")),
    })

    expect(() => {
      syncSink.setScrollTop({ element: scroller.el, top: 10, type: "bottom-follow", source: "sync" })
    }).not.toThrow()

    asyncSink.setScrollTop({ element: scroller.el, top: 20, type: "bottom-follow", source: "async" })
    await Promise.resolve()

    expect(syncSink.records()[0]?.source).toBe("sync")
    expect(asyncSink.records()[0]?.source).toBe("async")
  })
})
