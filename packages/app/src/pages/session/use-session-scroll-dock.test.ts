import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import {
  calculateSessionScrollState,
  createSessionScrollDock,
  shouldStickToBottomAfterDockResize,
  syncComposerDockHeight,
} from "./use-session-scroll-dock"

function makeScroller(input: { clientHeight: number; scrollHeight: number; scrollTop: number }) {
  const el = document.createElement("div") as HTMLDivElement
  let top = input.scrollTop
  let height = input.scrollHeight

  Object.defineProperties(el, {
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
    value: () => ({
      width: 720,
      height: current,
      top: 0,
      right: 720,
      bottom: current,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
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
      const rect = target.getBoundingClientRect()
      const entry = { target, contentRect: rect } as ResizeObserverEntry
      for (const item of observed.get(target) ?? []) item([entry])
    })
  } finally {
    globalThis.ResizeObserver = original
  }
}

describe("session scroll dock", () => {
  test("calculates bottom state with two-pixel tolerance", () => {
    const state = calculateSessionScrollState({
      clientHeight: 400,
      scrollHeight: 1000,
      scrollTop: 599,
    })

    expect(state).toEqual({
      overflow: true,
      bottom: true,
      jump: false,
    })
  })

  test("marks jump when distance is larger than viewport threshold", () => {
    const state = calculateSessionScrollState({
      clientHeight: 400,
      scrollHeight: 1400,
      scrollTop: 100,
    })

    expect(state).toEqual({
      overflow: true,
      bottom: false,
      jump: true,
    })
  })

  test("sticks to bottom when the user is already following the latest turn", () => {
    const scroller = makeScroller({
      clientHeight: 400,
      scrollHeight: 1000,
      scrollTop: 600,
    })

    const stick = shouldStickToBottomAfterDockResize({
      el: scroller.el,
      userScrolled: false,
      previousDockHeight: 120,
      nextDockHeight: 180,
    })

    expect(stick).toBe(true)
  })

  test("does not force bottom when the user intentionally scrolled upward", () => {
    const scroller = makeScroller({
      clientHeight: 400,
      scrollHeight: 1000,
      scrollTop: 200,
    })

    const stick = shouldStickToBottomAfterDockResize({
      el: scroller.el,
      userScrolled: true,
      previousDockHeight: 120,
      nextDockHeight: 180,
    })

    expect(stick).toBe(false)
  })

  test("syncs composer height through one path and scrolls once when sticky", () => {
    const previousDockHeight = document.documentElement.style.getPropertyValue("--composer-dock-height")
    const scroller = makeScroller({
      clientHeight: 400,
      scrollHeight: 1000,
      scrollTop: 600,
    })
    const calls: number[] = []

    try {
      const next = syncComposerDockHeight({
        el: scroller.el,
        previousDockHeight: 120,
        nextDockHeight: 180,
        userScrolled: false,
        setCssHeight: (height) => {
          document.documentElement.style.setProperty("--composer-dock-height", `${height}px`)
        },
        forceScrollToBottom: () => {
          calls.push(1)
          scroller.el.scrollTop = scroller.el.scrollHeight
        },
        scheduleScrollState: () => undefined,
        fill: () => undefined,
      })

      expect(next).toBe(180)
      expect(document.documentElement.style.getPropertyValue("--composer-dock-height")).toBe("180px")
      expect(calls).toHaveLength(1)
      expect(scroller.top).toBe(1000)
    } finally {
      if (previousDockHeight) document.documentElement.style.setProperty("--composer-dock-height", previousDockHeight)
      else document.documentElement.style.removeProperty("--composer-dock-height")
    }
  })

  test("keeps the previous composer height during transient zero measurements", () => {
    const scroller = makeScroller({
      clientHeight: 400,
      scrollHeight: 1000,
      scrollTop: 600,
    })
    const cssHeights: number[] = []
    const scrolls: number[] = []
    const schedules: number[] = []
    const fills: number[] = []

    const next = syncComposerDockHeight({
      el: scroller.el,
      previousDockHeight: 180,
      nextDockHeight: 0,
      userScrolled: false,
      setCssHeight: (height) => cssHeights.push(height),
      forceScrollToBottom: () => scrolls.push(1),
      scheduleScrollState: () => schedules.push(1),
      fill: () => fills.push(1),
    })

    expect(next).toBe(180)
    expect(cssHeights).toHaveLength(0)
    expect(scrolls).toHaveLength(0)
    expect(schedules).toHaveLength(1)
    expect(fills).toHaveLength(1)
  })

  test("updates composer CSS height when the prompt dock resizes after mount", () => {
    withResizeObserver((triggerResize) => {
      createRoot((dispose) => {
        const previousDockHeight = document.documentElement.style.getPropertyValue("--composer-dock-height")
        const promptDock = makeMeasuredDiv(120)
        const events: Array<{
          composerHeight: number
          previousComposerHeight: number
          scrollTop?: number
          distanceFromBottom?: number
        }> = []
        const scroller = makeScroller({
          clientHeight: 400,
          scrollHeight: 1000,
          scrollTop: 600,
        })

        try {
          const scrollDock = createSessionScrollDock({
            clearMessageHash: () => undefined,
            clearActiveMessage: () => undefined,
            fill: () => undefined,
            onDockHeightChange: (event) => events.push(event),
          })

          scrollDock.setScrollRef(scroller.el)
          scrollDock.setPromptDockRef(promptDock.el)
          expect(document.documentElement.style.getPropertyValue("--composer-dock-height")).toBe("120px")

          promptDock.setHeight(220)
          triggerResize(promptDock.el)

          expect(document.documentElement.style.getPropertyValue("--composer-dock-height")).toBe("220px")
          expect(events).toEqual([
            {
              composerHeight: 120,
              previousComposerHeight: 0,
              scrollTop: 600,
              distanceFromBottom: 0,
            },
            {
              composerHeight: 220,
              previousComposerHeight: 120,
              scrollTop: 600,
              distanceFromBottom: 0,
            },
          ])
        } finally {
          dispose()
          if (previousDockHeight)
            document.documentElement.style.setProperty("--composer-dock-height", previousDockHeight)
          else document.documentElement.style.removeProperty("--composer-dock-height")
        }
      })
    })
  })

  test("restores a submit-time browser reset while bottom follow is locked", () => {
    createRoot((dispose) => {
      const scroller = makeScroller({
        clientHeight: 400,
        scrollHeight: 1000,
        scrollTop: 600,
      })
      const scrollDock = createSessionScrollDock({
        clearMessageHash: () => undefined,
        clearActiveMessage: () => undefined,
        fill: () => undefined,
      })

      scrollDock.setScrollRef(scroller.el)
      scrollDock.resumeScroll()
      scroller.el.scrollTop = 0

      expect(scrollDock.restoreBottomIfLocked()).toBe(true)
      expect(scroller.top).toBe(1000)

      dispose()
    })
  })

  test("repairs a locked reset before the next scroll state sample", () => {
    createRoot((dispose) => {
      const scroller = makeScroller({
        clientHeight: 400,
        scrollHeight: 1000,
        scrollTop: 600,
      })
      const scrollDock = createSessionScrollDock({
        clearMessageHash: () => undefined,
        clearActiveMessage: () => undefined,
        fill: () => undefined,
      })

      scrollDock.setScrollRef(scroller.el)
      scrollDock.resumeScroll()
      scroller.el.scrollTop = 0
      scrollDock.scheduleScrollState(scroller.el)

      expect(scroller.top).toBe(1000)

      dispose()
    })
  })

  test("does not restore after a real scroll gesture cancels the bottom follow lock", () => {
    createRoot((dispose) => {
      const scroller = makeScroller({
        clientHeight: 400,
        scrollHeight: 1000,
        scrollTop: 600,
      })
      const scrollDock = createSessionScrollDock({
        clearMessageHash: () => undefined,
        clearActiveMessage: () => undefined,
        fill: () => undefined,
      })

      scrollDock.setScrollRef(scroller.el)
      scrollDock.resumeScroll()
      scrollDock.cancelBottomFollowLock()
      scroller.el.scrollTop = 0

      expect(scrollDock.restoreBottomIfLocked()).toBe(false)
      expect(scroller.top).toBe(0)

      dispose()
    })
  })

  test("does not restore or clear hash when the lock belongs to another session", () => {
    createRoot((dispose) => {
      const scroller = makeScroller({
        clientHeight: 400,
        scrollHeight: 1000,
        scrollTop: 600,
      })
      let clearedHash = 0
      const scrollDock = createSessionScrollDock({
        clearMessageHash: () => {
          clearedHash += 1
        },
        clearActiveMessage: () => undefined,
        fill: () => undefined,
      })

      scrollDock.setScrollRef(scroller.el)
      scrollDock.resumeScroll("session-a")
      scroller.el.scrollTop = 0

      expect(scrollDock.restoreBottomIfLocked("session-b")).toBe(false)
      expect(scroller.top).toBe(0)
      expect(clearedHash).toBe(1)
      expect(scrollDock.bottomFollowLocked("session-a")).toBe(false)

      dispose()
    })
  })
})
