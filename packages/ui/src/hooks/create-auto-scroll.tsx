import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"

export interface AutoScrollOptions {
  working: () => boolean
  onUserInteracted?: () => void
  overflowAnchor?: "none" | "auto" | "dynamic"
  bottomThreshold?: number
  executeScrollCommand?: (command: AutoScrollCommand) => void
}

export type AutoScrollCommand = {
  element: HTMLElement
  top: number
  behavior: ScrollBehavior
  method: "scroll-to" | "set-scroll-top"
  reason: AutoScrollReason
}

export type AutoScrollReason =
  | "content-resize"
  | "dock-resize"
  | "force-bottom"
  | "follow-bottom"
  | "resume"
  | "working-start"

export function createAutoScroll(options: AutoScrollOptions) {
  let settling = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let autoTimer: ReturnType<typeof setTimeout> | undefined
  let auto: { top: number; time: number } | undefined

  const threshold = () => options.bottomThreshold ?? 10

  const [store, setStore] = createStore({
    contentRef: undefined as HTMLElement | undefined,
    scrollRef: undefined as HTMLElement | undefined,
    userScrolled: false,
  })

  const active = () => options.working() || settling

  const distanceFromBottom = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight - el.scrollTop
  }

  const canScroll = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight > 1
  }

  const updateOverflowAnchor = (el: HTMLElement) => {
    const mode = options.overflowAnchor ?? "dynamic"

    if (mode === "none") {
      el.style.overflowAnchor = "none"
      return
    }

    if (mode === "auto") {
      el.style.overflowAnchor = "auto"
      return
    }

    el.style.overflowAnchor = store.userScrolled ? "auto" : "none"
  }

  // Browsers can dispatch scroll events asynchronously. If new content arrives
  // between us calling `scrollTo()` and the subsequent `scroll` event firing,
  // the handler can see a non-zero `distanceFromBottom` and incorrectly assume
  // the user scrolled.
  const markAuto = (el: HTMLElement) => {
    auto = {
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      time: Date.now(),
    }

    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = setTimeout(() => {
      auto = undefined
      autoTimer = undefined
    }, 1500)
  }

  const isAuto = (el: HTMLElement) => {
    const a = auto
    if (!a) return false

    if (Date.now() - a.time > 1500) {
      auto = undefined
      return false
    }

    return Math.abs(el.scrollTop - a.top) < 2
  }

  const executeScrollCommand = (command: AutoScrollCommand) => {
    if (options.executeScrollCommand) {
      options.executeScrollCommand(command)
      return
    }

    if (command.method === "scroll-to") {
      command.element.scrollTo({ top: command.top, behavior: command.behavior })
      return
    }

    command.element.scrollTop = command.top
  }

  const scrollToBottomNow = (behavior: ScrollBehavior, reason: AutoScrollReason) => {
    const el = store.scrollRef
    if (!el) return
    markAuto(el)
    if (behavior === "smooth") {
      executeScrollCommand({ element: el, top: el.scrollHeight, behavior, method: "scroll-to", reason })
      return
    }

    // `scrollTop` assignment bypasses any CSS `scroll-behavior: smooth`.
    executeScrollCommand({ element: el, top: el.scrollHeight, behavior, method: "set-scroll-top", reason })
  }

  const scrollToBottom = (force: boolean, reason: AutoScrollReason = force ? "force-bottom" : "follow-bottom") => {
    if (!force && !active()) return

    const el = store.scrollRef

    if (force && store.userScrolled) {
      setStore("userScrolled", false)
      if (el) updateOverflowAnchor(el)
    }

    if (!el) return

    if (!force && store.userScrolled) return

    const distance = distanceFromBottom(el)
    if (distance < 2) {
      markAuto(el)
      return
    }

    // For auto-following content we prefer immediate updates to avoid
    // visible "catch up" animations while content is still settling.
    scrollToBottomNow("auto", reason)
  }

  const stop = () => {
    const el = store.scrollRef
    if (!el) return
    if (!canScroll(el)) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }
    if (store.userScrolled) return

    setStore("userScrolled", true)
    options.onUserInteracted?.()
  }

  const handleWheel = (e: WheelEvent) => {
    if (e.deltaY >= 0) return
    // If the user is scrolling within a nested scrollable region (tool output,
    // code block, etc), don't treat it as leaving the "follow bottom" mode.
    // Those regions opt in via `data-scrollable`.
    const el = store.scrollRef
    const target = e.target instanceof Element ? e.target : undefined
    const nested = target?.closest("[data-scrollable]")
    if (el && nested && nested !== el) return
    stop()
  }

  const handleScroll = () => {
    const el = store.scrollRef
    if (!el) return

    if (!canScroll(el)) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }

    if (distanceFromBottom(el) < threshold()) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }

    // Ignore scroll events triggered by our own scrollToBottom calls.
    if (!store.userScrolled && isAuto(el)) {
      scrollToBottom(false, "content-resize")
      return
    }

    stop()
  }

  const handleInteraction = () => {
    if (!active()) return
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) {
      stop()
    }
  }

  createResizeObserver(
    () => store.contentRef,
    () => {
      const el = store.scrollRef
      if (el && !canScroll(el)) {
        if (store.userScrolled) setStore("userScrolled", false)
        return
      }
      if (!active()) return
      if (store.userScrolled) return
      // ResizeObserver fires after layout, before paint.
      // Keep the bottom locked in the same frame to avoid visible
      // "jump up then catch up" artifacts while streaming content.
      scrollToBottom(false, "content-resize")
    },
  )

  createEffect(
    on(options.working, (working: boolean) => {
      settling = false
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = undefined

      if (working) {
        if (!store.userScrolled) scrollToBottom(true, "working-start")
        return
      }

      settling = true
      settleTimer = setTimeout(() => {
        settling = false
      }, 300)
    }),
  )

  createEffect(() => {
    // Track `userScrolled` even before `scrollRef` is attached, so we can
    // update overflow anchoring once the element exists.
    store.userScrolled
    const el = store.scrollRef
    if (!el) return
    updateOverflowAnchor(el)
  })

  createEventListener(() => store.scrollRef, "wheel", handleWheel, { passive: true })

  onCleanup(() => {
    if (settleTimer) clearTimeout(settleTimer)
    if (autoTimer) clearTimeout(autoTimer)
  })

  return {
    scrollRef: (el: HTMLElement | undefined) => setStore("scrollRef", el),
    contentRef: (el: HTMLElement | undefined) => setStore("contentRef", el),
    handleScroll,
    handleInteraction,
    pause: stop,
    resume: () => {
      if (store.userScrolled) setStore("userScrolled", false)
      scrollToBottom(true, "resume")
    },
    scrollToBottom: (reason?: AutoScrollReason) => scrollToBottom(false, reason),
    forceScrollToBottom: (reason?: AutoScrollReason) => scrollToBottom(true, reason),
    userScrolled: () => store.userScrolled,
  }
}
