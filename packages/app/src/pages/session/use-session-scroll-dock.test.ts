import { describe, expect, test } from "bun:test"
import {
  calculateSessionScrollState,
  shouldStickToBottomAfterDockResize,
  syncComposerDockHeight,
} from "./use-session-scroll-dock"

function makeScroller(input: {
  clientHeight: number
  scrollHeight: number
  scrollTop: number
}) {
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
})
