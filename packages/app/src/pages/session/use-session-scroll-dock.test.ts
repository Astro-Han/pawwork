import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { calculateSessionScrollState, createSessionScrollDock, syncComposerDockHeight } from "./use-session-scroll-dock"

function makeScroller(input: { clientHeight: number; scrollHeight: number; scrollTop: number }) {
  const el = document.createElement("div") as HTMLDivElement
  let top = input.scrollTop
  let height = input.scrollHeight

  Object.defineProperties(el, {
    clientHeight: { value: input.clientHeight, configurable: true },
    scrollHeight: { configurable: true, get: () => height, set: (value) => { height = value } },
    scrollTop: { configurable: true, get: () => top, set: (value) => { top = value } },
  })

  return {
    el,
    get top() {
      return top
    },
    setScrollHeight(value: number) {
      height = value
    },
  }
}

function makeMeasuredDiv(height: number) {
  const el = document.createElement("div") as HTMLDivElement
  let current = height
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 720, height: current, top: 0, right: 720, bottom: current, left: 0, x: 0, y: 0, toJSON: () => ({}) }),
  })
  return {
    el,
    setHeight(value: number) {
      current = value
    },
  }
}

function withResizeObserver(callback: (trigger: (target: Element) => void) => void) {
  const original = globalThis.ResizeObserver
  const observed = new Map<Element, Set<(entries: ResizeObserverEntry[]) => void>>()

  class TestResizeObserver {
    private callback: (entries: ResizeObserverEntry[]) => void
    constructor(callback: (entries: ResizeObserverEntry[]) => void) {
      this.callback = callback
    }
    observe = (target: Element) => {
      const callbacks = observed.get(target) ?? new Set()
      callbacks.add(this.callback)
      observed.set(target, callbacks)
    }
    unobserve = (target: Element) => {
      observed.get(target)?.delete(this.callback)
    }
    disconnect = () => {
      for (const callbacks of observed.values()) callbacks.delete(this.callback)
    }
  }

  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver
  try {
    callback((target) => {
      const entry = { target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry
      for (const item of observed.get(target) ?? []) item([entry])
    })
  } finally {
    globalThis.ResizeObserver = original
  }
}

const flushFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

describe("calculateSessionScrollState", () => {
  test("flags overflow, bottom, and jump from geometry", () => {
    expect(calculateSessionScrollState({ clientHeight: 400, scrollHeight: 400, scrollTop: 0 })).toEqual({
      overflow: false,
      bottom: true,
      jump: false,
    })
    expect(calculateSessionScrollState({ clientHeight: 400, scrollHeight: 2000, scrollTop: 1600 })).toEqual({
      overflow: true,
      bottom: true,
      jump: false,
    })
    expect(calculateSessionScrollState({ clientHeight: 400, scrollHeight: 2000, scrollTop: 0 })).toEqual({
      overflow: true,
      bottom: false,
      jump: true,
    })
  })
})

describe("syncComposerDockHeight", () => {
  test("sets the css height, schedules scroll state, fills, and returns the next height", () => {
    const scheduled: HTMLDivElement[] = []
    let filled = 0
    let css = 0
    const scroller = makeScroller({ clientHeight: 400, scrollHeight: 1000, scrollTop: 0 })

    const next = syncComposerDockHeight({
      el: scroller.el,
      previousDockHeight: 40,
      nextDockHeight: 96,
      setCssHeight: (value) => { css = value },
      scheduleScrollState: (el) => scheduled.push(el),
      fill: () => { filled += 1 },
    })

    expect(next).toBe(96)
    expect(css).toBe(96)
    expect(scheduled).toEqual([scroller.el])
    expect(filled).toBe(1)
  })

  test("keeps the previous height and does not set css when the next height is non-positive", () => {
    let css = -1
    const next = syncComposerDockHeight({
      el: undefined,
      previousDockHeight: 64,
      nextDockHeight: 0,
      setCssHeight: (value) => { css = value },
      scheduleScrollState: () => {},
      fill: () => {},
    })
    expect(next).toBe(64)
    expect(css).toBe(-1)
  })
})

describe("createSessionScrollDock", () => {
  test("disables native scroll anchoring on the timeline viewport", () => {
    createRoot((dispose) => {
      const dock = createSessionScrollDock({ fill: () => {} })
      const scroller = makeScroller({ clientHeight: 400, scrollHeight: 1000, scrollTop: 0 })
      dock.setScrollRef(scroller.el)
      expect(scroller.el.style.overflowAnchor).toBe("none")
      dispose()
    })
  })

  test("reports content resize with viewport metrics and refills", () => {
    withResizeObserver((trigger) => {
      createRoot((dispose) => {
        const events: Array<{ scrollTop?: number; distanceFromBottom?: number }> = []
        let filled = 0
        const dock = createSessionScrollDock({ fill: () => { filled += 1 }, onContentResize: (event) => events.push(event) })
        const scroller = makeScroller({ clientHeight: 400, scrollHeight: 1200, scrollTop: 300 })
        const content = makeMeasuredDiv(1200)
        dock.setScrollRef(scroller.el)
        dock.setContentRef(content.el)
        filled = 0

        trigger(content.el)
        expect(events).toEqual([{ scrollTop: 300, distanceFromBottom: 500 }])
        expect(filled).toBeGreaterThan(0)
        dispose()
      })
    })
  })

  test("stabilizes content resize around the resize callback and refill", () => {
    withResizeObserver((trigger) => {
      createRoot((dispose) => {
        const order: string[] = []
        const dock = createSessionScrollDock({
          fill: () => order.push("fill"),
          onContentResize: () => order.push("content-resize"),
          stabilizeLayout: ({ reason, mutate }) => {
            order.push(`stabilize:${reason}:start`)
            mutate()
            order.push(`stabilize:${reason}:end`)
          },
        })
        const scroller = makeScroller({ clientHeight: 400, scrollHeight: 1200, scrollTop: 300 })
        const content = makeMeasuredDiv(1200)
        dock.setScrollRef(scroller.el)
        dock.setContentRef(content.el)
        order.length = 0

        trigger(content.el)

        expect(order).toEqual([
          "stabilize:content-resize:start",
          "content-resize",
          "fill",
          "stabilize:content-resize:end",
        ])
        dispose()
      })
    })
  })

  test("reports dock height changes with the dock kind and sets the css variable", () => {
    withResizeObserver(() => {
      createRoot((dispose) => {
        const events: Array<{
          dockKind: string
          composerHeight: number
          previousComposerHeight: number
          scrollTop?: number
          distanceFromBottom?: number
        }> = []
        const dock = createSessionScrollDock({ fill: () => {}, onDockHeightChange: (event) => events.push(event) })
        const scroller = makeScroller({ clientHeight: 400, scrollHeight: 1000, scrollTop: 0 })
        dock.setScrollRef(scroller.el)

        const promptDock = makeMeasuredDiv(120)
        promptDock.el.dataset.dockKind = "question"
        dock.setPromptDockRef(promptDock.el)

        expect(events).toEqual([{ dockKind: "question", composerHeight: 120, previousComposerHeight: 0, scrollTop: 0, distanceFromBottom: 600 }])
        expect(document.documentElement.style.getPropertyValue("--composer-dock-height")).toBe("120px")
        dispose()
      })
    })
  })

  test("stabilizes dock resize around height sync and event reporting", () => {
    withResizeObserver(() => {
      createRoot((dispose) => {
        const order: string[] = []
        const dock = createSessionScrollDock({
          fill: () => order.push("fill"),
          onDockHeightChange: () => order.push("dock-resize"),
          stabilizeLayout: ({ reason, mutate }) => {
            order.push(`stabilize:${reason}:start`)
            mutate()
            order.push(`stabilize:${reason}:end`)
          },
        })
        const scroller = makeScroller({ clientHeight: 400, scrollHeight: 1000, scrollTop: 0 })
        dock.setScrollRef(scroller.el)
        order.length = 0

        const promptDock = makeMeasuredDiv(120)
        promptDock.el.dataset.dockKind = "question"
        dock.setPromptDockRef(promptDock.el)

        expect(order).toEqual([
          "stabilize:dock-resize:start",
          "fill",
          "dock-resize",
          "stabilize:dock-resize:end",
        ])
        dispose()
      })
    })
  })

  test("updates the jump-button scroll state on the next frame", async () => {
    let dispose = () => {}
    const dock = createRoot((d) => {
      dispose = d
      return createSessionScrollDock({ fill: () => {} })
    })
    const scroller = makeScroller({ clientHeight: 400, scrollHeight: 2000, scrollTop: 0 })
    dock.setScrollRef(scroller.el)
    dock.scheduleScrollState(scroller.el)
    await flushFrame()
    expect(dock.scroll).toMatchObject({ overflow: true, bottom: false, jump: true })
    dispose()
  })
})
