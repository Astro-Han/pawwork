import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

export type SessionScrollState = {
  overflow: boolean
  bottom: boolean
  jump: boolean
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

export function shouldStickToBottomAfterDockResize(input: {
  el: HTMLElement
  userScrolled: boolean
  previousDockHeight: number
  nextDockHeight: number
}) {
  const delta = input.nextDockHeight - input.previousDockHeight
  const distance = input.el.scrollHeight - input.el.clientHeight - input.el.scrollTop
  return !input.userScrolled || distance < 10 + Math.max(0, delta)
}

export function syncComposerDockHeight(input: {
  el: HTMLElement | undefined
  previousDockHeight: number
  nextDockHeight: number
  userScrolled: boolean
  setCssHeight: (height: number) => void
  forceScrollToBottom: () => void
  scheduleScrollState: (el: HTMLDivElement) => void
  fill: () => void
}) {
  input.setCssHeight(input.nextDockHeight)

  if (input.nextDockHeight === input.previousDockHeight) {
    if (input.el instanceof HTMLDivElement) input.scheduleScrollState(input.el)
    input.fill()
    return input.previousDockHeight
  }

  const stick = input.el
    ? shouldStickToBottomAfterDockResize({
        el: input.el,
        userScrolled: input.userScrolled,
        previousDockHeight: input.previousDockHeight,
        nextDockHeight: input.nextDockHeight,
      })
    : false

  if (stick) input.forceScrollToBottom()
  if (input.el instanceof HTMLDivElement) input.scheduleScrollState(input.el)
  input.fill()

  return input.nextDockHeight
}

export function createSessionScrollDock(input: {
  clearMessageHash: () => void
  clearActiveMessage: () => void
  fill: () => void
}) {
  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "dynamic",
  })

  const [scroll, setScroll] = createStore<SessionScrollState>({
    overflow: false,
    bottom: true,
    jump: false,
  })

  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let promptDock: HTMLDivElement | undefined
  let dockHeight = 0
  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined

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
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    input.fill()
  }

  const setContentRef = (el: HTMLDivElement | undefined) => {
    content = el
    autoScroll.contentRef(el)
    if (el && scroller) scheduleScrollState(scroller)
  }

  const updateDockHeight = (next: number) => {
    dockHeight = syncComposerDockHeight({
      el: scroller,
      previousDockHeight: dockHeight,
      nextDockHeight: next,
      userScrolled: autoScroll.userScrolled(),
      setCssHeight: (value) => document.documentElement.style.setProperty("--composer-dock-height", `${value}px`),
      forceScrollToBottom: autoScroll.forceScrollToBottom,
      scheduleScrollState,
      fill: input.fill,
    })
  }

  const setPromptDockRef = (el: HTMLDivElement | undefined) => {
    promptDock = el
    if (!el) return
    const next = Math.ceil(el.getBoundingClientRect().height)
    if (next > 0) updateDockHeight(next)
  }

  const resumeScroll = () => {
    input.clearActiveMessage()
    autoScroll.forceScrollToBottom()
    input.clearMessageHash()
    if (scroller) scheduleScrollState(scroller)
  }

  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        input.clearActiveMessage()
        input.clearMessageHash()
      },
      { defer: true },
    ),
  )

  createResizeObserver(
    () => content,
    () => {
      if (scroller) scheduleScrollState(scroller)
      input.fill()
    },
  )

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      updateDockHeight(Math.ceil(height))
    },
  )

  onCleanup(() => {
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    document.documentElement.style.removeProperty("--composer-dock-height")
  })

  return {
    autoScroll,
    scroll,
    scroller: () => scroller,
    setScrollRef,
    setContentRef,
    setPromptDockRef,
    scheduleScrollState,
    resumeScroll,
  }
}
