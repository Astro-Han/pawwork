import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { TimelineDockKind } from "./session-timeline-scroll-controller"

export type SessionScrollState = {
  overflow: boolean
  bottom: boolean
  jump: boolean
}

export type SessionDockResizeEvent = {
  dockKind: TimelineDockKind
  composerHeight: number
  previousComposerHeight: number
  scrollTop?: number
  distanceFromBottom?: number
}

export type SessionContentResizeEvent = {
  scrollTop?: number
  distanceFromBottom?: number
}

export function calculateSessionScrollState(input: {
  clientHeight: number
  scrollHeight: number
  scrollTop: number
}): SessionScrollState {
  const max = input.scrollHeight - input.clientHeight
  const distance = max - input.scrollTop
  const overflow = max > 1
  const jumpThreshold = Math.max(400, input.clientHeight)

  return {
    overflow,
    bottom: !overflow || distance <= 2,
    jump: overflow && distance > jumpThreshold,
  }
}

export function syncComposerDockHeight(input: {
  el: HTMLElement | undefined
  previousDockHeight: number
  nextDockHeight: number
  setCssHeight: (height: number) => void
  scheduleScrollState: (el: HTMLDivElement) => void
  fill: () => void
}) {
  if (input.nextDockHeight > 0) input.setCssHeight(input.nextDockHeight)
  if (input.el instanceof HTMLDivElement) input.scheduleScrollState(input.el)
  input.fill()
  return input.nextDockHeight > 0 ? input.nextDockHeight : input.previousDockHeight
}

/**
 * Owns timeline viewport refs, dock-height measurement, and the jump-button
 * scroll state (overflow / bottom / jump). It observes layout changes and
 * reports them; it does NOT decide or write scroll position. The reconciler is
 * the single authoritative writer — this hook only fires `onContentResize` /
 * `onDockHeightChange` so the host can mark the reconciler dirty.
 */
export function createSessionScrollDock(input: {
  fill: () => void
  onDockHeightChange?: (event: SessionDockResizeEvent) => void
  onContentResize?: (event: SessionContentResizeEvent) => void
}) {
  const [scroll, setScroll] = createStore<SessionScrollState>({
    overflow: false,
    bottom: true,
    jump: false,
  })

  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let promptDock: HTMLDivElement | undefined
  let contentObserver: ResizeObserver | undefined
  let promptDockObserver: ResizeObserver | undefined
  let dockHeight = 0
  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined

  const distanceFromBottom = () =>
    scroller ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop : undefined

  const updateScrollState = (el: HTMLDivElement) => {
    const next = calculateSessionScrollState({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    })

    if (scroll.overflow === next.overflow && scroll.bottom === next.bottom && scroll.jump === next.jump) return
    setScroll(next)
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined
      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (target) updateScrollState(target)
    })
  }

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    if (!el) return
    // Disable native browser scroll anchoring on the timeline viewport: the
    // reconciler is the sole authority for position. Nested [data-scrollable]
    // regions keep their own anchoring.
    el.style.overflowAnchor = "none"
    scheduleScrollState(el)
    input.fill()
  }

  const setContentRef = (el: HTMLDivElement | undefined) => {
    contentObserver?.disconnect()
    contentObserver = undefined
    content = el
    if (el && scroller) scheduleScrollState(scroller)
    if (!el) return
    contentObserver = new ResizeObserver(() => {
      input.onContentResize?.({ scrollTop: scroller?.scrollTop, distanceFromBottom: distanceFromBottom() })
      if (scroller) scheduleScrollState(scroller)
      input.fill()
    })
    contentObserver.observe(el)
  }

  const measurePromptDockHeight = () => Math.ceil(promptDock?.getBoundingClientRect().height ?? 0)
  const promptDockKind = (): TimelineDockKind => {
    const value = promptDock?.dataset.dockKind
    if (
      value === "composer" ||
      value === "question" ||
      value === "permission" ||
      value === "followup" ||
      value === "revert" ||
      value === "prompt"
    ) {
      return value
    }
    return "composer"
  }

  const updateDockHeight = (next: number) => {
    const previousDockHeight = dockHeight
    const dockKind = promptDockKind()
    const scrollTop = scroller?.scrollTop
    const distance = distanceFromBottom()

    dockHeight = syncComposerDockHeight({
      el: scroller,
      previousDockHeight,
      nextDockHeight: next,
      setCssHeight: (value) => document.documentElement.style.setProperty("--composer-dock-height", `${value}px`),
      scheduleScrollState,
      fill: input.fill,
    })

    if (dockHeight !== previousDockHeight) {
      try {
        input.onDockHeightChange?.({
          dockKind,
          composerHeight: dockHeight,
          previousComposerHeight: previousDockHeight,
          scrollTop,
          distanceFromBottom: distance,
        })
      } catch (error) {
        if (import.meta.env.DEV) console.warn("[session-scroll-dock] onDockHeightChange failed", error)
      }
    }
  }

  const setPromptDockRef = (el: HTMLDivElement | undefined) => {
    promptDockObserver?.disconnect()
    promptDockObserver = undefined
    promptDock = el
    if (!el) return
    const next = measurePromptDockHeight()
    if (next > 0) updateDockHeight(next)
    promptDockObserver = new ResizeObserver(() => {
      updateDockHeight(measurePromptDockHeight())
    })
    promptDockObserver.observe(el)
  }

  onCleanup(() => {
    contentObserver?.disconnect()
    promptDockObserver?.disconnect()
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    document.documentElement.style.removeProperty("--composer-dock-height")
  })

  return {
    scroll,
    scroller: () => scroller,
    setScrollRef,
    setContentRef,
    setPromptDockRef,
    scheduleScrollState,
  }
}
