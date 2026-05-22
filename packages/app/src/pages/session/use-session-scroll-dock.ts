import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import {
  createTimelineScrollCommandSink,
  type TimelineScrollCommandSink,
  type TimelineScrollCommandTransaction,
  type TimelineScrollCommandType,
} from "./timeline-scroll-command-sink"
import type { TimelineLayoutTransactionKind } from "./timeline-layout-transaction"

export type SessionScrollState = {
  overflow: boolean
  bottom: boolean
  jump: boolean
}

type SessionLayoutTransactionInput = {
  kind: Extract<TimelineLayoutTransactionKind, "dock-resize" | "content-resize">
  source: string
  reason: string
  stickToBottom: boolean
  mutate: () => void
  restoreLatest: (transactionID: string) => boolean
}

const BOTTOM_FOLLOW_LOCK_MS = 3_000

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
  if (input.nextDockHeight <= 0) {
    if (input.el instanceof HTMLDivElement) input.scheduleScrollState(input.el)
    input.fill()
    return input.previousDockHeight
  }

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
  onDockHeightChange?: (event: {
    dockKind: "composer" | "question" | "permission" | "todo" | "followup" | "revert" | "prompt"
    composerHeight: number
    previousComposerHeight: number
    layoutTransactionHandled?: boolean
    scrollTop?: number
    distanceFromBottom?: number
  }) => void
  onContentResize?: (event: { scrollTop?: number; distanceFromBottom?: number }) => void
  runLayoutTransaction?: (input: SessionLayoutTransactionInput) => void
  scrollCommandSink?: TimelineScrollCommandSink
}) {
  const fallbackTimelineScrollCommandSink = createTimelineScrollCommandSink()
  const scrollCommandSink = () => input.scrollCommandSink ?? fallbackTimelineScrollCommandSink
  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "dynamic",
    executeScrollCommand: (command) => {
      const type: TimelineScrollCommandType =
        command.reason === "content-resize"
          ? "content-resize-bottom-follow"
          : command.reason === "dock-resize"
            ? "dock-resize-bottom-follow"
            : "bottom-follow"
      const source = `use-session-scroll-dock/createAutoScroll:${command.reason}`
      const next = {
        element: command.element,
        top: command.top,
        type,
        source,
        reason: command.reason,
      }
      if (command.method === "scroll-to") {
        scrollCommandSink().scrollTo({ ...next, behavior: command.behavior })
        return
      }
      scrollCommandSink().setScrollTop(next)
    },
  })

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
  let bottomFollowLockTimer: ReturnType<typeof setTimeout> | undefined
  let bottomFollowLockOwner: string | undefined
  const [bottomFollowLocked, setBottomFollowLocked] = createSignal(false)

  const cancelBottomFollowLock = () => {
    if (bottomFollowLockTimer !== undefined) {
      clearTimeout(bottomFollowLockTimer)
      bottomFollowLockTimer = undefined
    }
    setBottomFollowLocked(false)
    bottomFollowLockOwner = undefined
  }

  const armBottomFollowLock = (owner?: string) => {
    if (bottomFollowLockTimer !== undefined) clearTimeout(bottomFollowLockTimer)
    bottomFollowLockOwner = owner
    setBottomFollowLocked(true)
    bottomFollowLockTimer = setTimeout(cancelBottomFollowLock, BOTTOM_FOLLOW_LOCK_MS)
  }

  const bottomFollowLockedFor = (owner?: string) => {
    if (!bottomFollowLocked()) return false
    return owner === undefined || bottomFollowLockOwner === undefined || owner === bottomFollowLockOwner
  }

  const followBottom = () => {
    input.clearActiveMessage()
    autoScroll.forceScrollToBottom("force-bottom")
    input.clearMessageHash()
  }

  const updateScrollState = (el: HTMLDivElement) => {
    const next = calculateSessionScrollState({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    })

    if (scroll.overflow === next.overflow && scroll.bottom === next.bottom && scroll.jump === next.jump) return
    setScroll(next)
  }

  const scheduleScrollState = (el: HTMLDivElement, options?: { recoverBottomLock?: boolean }) => {
    if (options?.recoverBottomLock !== false && bottomFollowLocked()) {
      const next = calculateSessionScrollState({
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      })
      if (next.overflow && !next.bottom) {
        followBottom()
      }
    }

    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (target) updateScrollState(target)
    })
  }

  const scheduleTransactionScrollState = (el: HTMLDivElement) => {
    scheduleScrollState(el, { recoverBottomLock: false })
  }

  // A non-matching owner means the active lock belongs to an older session path.
  // Cancel it before it can call followBottom or schedule another scroll sample.
  const restoreBottomIfLocked = (owner?: string) => {
    if (!bottomFollowLockedFor(owner)) {
      if (bottomFollowLocked() && owner !== undefined) cancelBottomFollowLock()
      return false
    }
    followBottom()
    if (scroller) scheduleScrollState(scroller)
    return true
  }

  const restoreLatestThroughSink = (input: {
    transaction: TimelineScrollCommandTransaction
    type: Extract<TimelineScrollCommandType, "content-resize-bottom-follow" | "dock-resize-bottom-follow">
    source: string
    reason: string
  }) => {
    if (!scroller) return false
    scrollCommandSink().withTransaction(input.transaction).setScrollTop({
      element: scroller,
      top: scroller.scrollHeight,
      type: input.type,
      source: input.source,
      reason: input.reason,
    })
    if (scroller) scheduleScrollState(scroller)
    return true
  }

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    input.fill()
    restoreBottomIfLocked()
  }

  const setContentRef = (el: HTMLDivElement | undefined) => {
    contentObserver?.disconnect()
    contentObserver = undefined
    content = el
    autoScroll.contentRef(el)
    if (el && scroller) scheduleScrollState(scroller)
    if (!el) return
    contentObserver = new ResizeObserver(() => {
      const runContentMutation = (scheduleState: (el: HTMLDivElement) => void) => {
        input.onContentResize?.({
          scrollTop: scroller?.scrollTop,
          distanceFromBottom: scroller ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop : undefined,
        })
        if (scroller) scheduleState(scroller)
        input.fill()
      }

      if (input.runLayoutTransaction && scroller) {
        input.runLayoutTransaction({
          kind: "content-resize",
          source: "use-session-scroll-dock/contentObserver",
          reason: "content-resize",
          stickToBottom: bottomFollowLockedFor(),
          mutate: () => runContentMutation(scheduleTransactionScrollState),
          restoreLatest: (transactionID) =>
            restoreLatestThroughSink({
              transaction: { transactionID, transactionKind: "content-resize" },
              type: "content-resize-bottom-follow",
              source: "use-session-scroll-dock/layoutTransactionRestoreLatest",
              reason: "content-resize",
            }),
        })
        return
      }

      runContentMutation(scheduleScrollState)
      restoreBottomIfLocked()
    })
    contentObserver.observe(el)
  }

  const updateDockHeight = (next: number) => {
    const previousDockHeight = dockHeight
    const dockKind = promptDockKind()
    const scrollTop = scroller?.scrollTop
    const distanceFromBottom = scroller ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop : undefined
    let layoutTransactionHandled = false
    const stickToBottom = scroller
      ? shouldStickToBottomAfterDockResize({
          el: scroller,
          userScrolled: autoScroll.userScrolled(),
          previousDockHeight,
          nextDockHeight: next,
        })
      : false
    const runDockMutation = (options: {
      forceScrollToBottom: () => void
      scheduleState: (el: HTMLDivElement) => void
    }) => {
      dockHeight = syncComposerDockHeight({
        el: scroller,
        previousDockHeight,
        nextDockHeight: next,
        userScrolled: autoScroll.userScrolled(),
        setCssHeight: (value) => document.documentElement.style.setProperty("--composer-dock-height", `${value}px`),
        forceScrollToBottom: options.forceScrollToBottom,
        scheduleScrollState: options.scheduleState,
        fill: input.fill,
      })
    }

    if (input.runLayoutTransaction && scroller && next !== previousDockHeight) {
      layoutTransactionHandled = true
      input.runLayoutTransaction({
        kind: "dock-resize",
        source: "use-session-scroll-dock/updateDockHeight",
        reason: dockKind,
        stickToBottom,
        mutate: () => runDockMutation({ forceScrollToBottom: () => {}, scheduleState: scheduleTransactionScrollState }),
        restoreLatest: (transactionID) =>
          restoreLatestThroughSink({
            transaction: { transactionID, transactionKind: "dock-resize" },
            type: "dock-resize-bottom-follow",
            source: "use-session-scroll-dock/layoutTransactionRestoreLatest",
            reason: "dock-resize",
          }),
      })
    } else {
      runDockMutation({
        forceScrollToBottom: () => autoScroll.forceScrollToBottom("dock-resize"),
        scheduleState: scheduleScrollState,
      })
    }
    if (dockHeight !== previousDockHeight) {
      try {
        input.onDockHeightChange?.({
          dockKind,
          composerHeight: dockHeight,
          previousComposerHeight: previousDockHeight,
          layoutTransactionHandled: layoutTransactionHandled || undefined,
          scrollTop,
          distanceFromBottom,
        })
      } catch (error) {
        if (import.meta.env.DEV) console.warn("[session-scroll-dock] onDockHeightChange failed", error)
      }
    }
  }

  const measurePromptDockHeight = () => Math.ceil(promptDock?.getBoundingClientRect().height ?? 0)
  const promptDockKind = () => {
    const value = promptDock?.dataset.dockKind
    if (
      value === "composer" ||
      value === "question" ||
      value === "permission" ||
      value === "todo" ||
      value === "followup" ||
      value === "revert" ||
      value === "prompt"
    ) {
      return value
    }
    return "composer"
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

  const resumeScroll = (owner?: string) => {
    armBottomFollowLock(owner)
    restoreBottomIfLocked(owner)
  }

  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) {
          cancelBottomFollowLock()
          return
        }
        input.clearActiveMessage()
        input.clearMessageHash()
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    contentObserver?.disconnect()
    promptDockObserver?.disconnect()
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (bottomFollowLockTimer !== undefined) clearTimeout(bottomFollowLockTimer)
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
    armBottomFollowLock,
    restoreBottomIfLocked,
    cancelBottomFollowLock,
    bottomFollowLocked: bottomFollowLockedFor,
  }
}
