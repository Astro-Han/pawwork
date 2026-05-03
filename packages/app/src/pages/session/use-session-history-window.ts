import type { UserMessage } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, on } from "solid-js"
import { createStore } from "solid-js/store"
import { emptyUserMessages } from "@/pages/session/session-messages"
import { same } from "@/utils/same"

export type SessionHistoryWindowInput = {
  sessionID: () => string | undefined
  messagesReady: () => boolean
  loaded: () => number
  visibleUserMessages: () => UserMessage[]
  historyMore: () => boolean
  historyLoading: () => boolean
  loadMore: (sessionID: string) => Promise<void>
  userScrolled: () => boolean
  scroller: () => HTMLDivElement | undefined
}

type HistoryWindowMode = "bottom" | "reading" | "hash"

export function resolveHistoryTurnStart(input: {
  mode: HistoryWindowMode
  storedTurnStart: number
  length: number
  userScrolled: boolean
  initialWindow?: number
}) {
  const initialWindow = input.initialWindow ?? 10
  const initial = input.length > initialWindow ? input.length - initialWindow : 0
  if (input.length <= 0) return 0
  if (input.mode === "bottom") return input.userScrolled ? Math.min(input.storedTurnStart, initial) : initial
  if (input.storedTurnStart <= 0) return 0
  if (input.storedTurnStart >= input.length) return initial
  return input.storedTurnStart
}

/**
 * Maintains the rendered history window for a session timeline.
 *
 * It keeps initial paint bounded to recent turns, reveals cached turns in
 * small batches while scrolling upward, and prefetches older history near top.
 */
export function createSessionHistoryWindow(input: SessionHistoryWindowInput) {
  const turnInit = 10
  const turnBatch = 8
  const turnScrollThreshold = 200
  const turnPrefetchBuffer = 16
  const prefetchCooldownMs = 400
  const prefetchNoGrowthLimit = 2

  const [state, setState] = createStore({
    turnID: undefined as string | undefined,
    turnStart: 0,
    prefetchUntil: 0,
    prefetchNoGrowth: 0,
    mode: "bottom" as HistoryWindowMode,
  })

  const initialTurnStart = (len: number) => (len > turnInit ? len - turnInit : 0)

  const turnStart = createMemo(() => {
    const id = input.sessionID()
    const len = input.visibleUserMessages().length
    if (!id || len <= 0) return 0
    if (state.turnID !== id) return initialTurnStart(len)
    return resolveHistoryTurnStart({
      mode: state.mode,
      storedTurnStart: state.turnStart,
      length: len,
      userScrolled: input.userScrolled(),
      initialWindow: turnInit,
    })
  })

  const setTurnStart = (start: number, opts?: { mode?: HistoryWindowMode }) => {
    const id = input.sessionID()
    const next = start > 0 ? start : 0
    const mode = opts?.mode ?? state.mode
    if (!id) {
      setState({ turnID: undefined, turnStart: next, mode })
      return
    }
    setState({ turnID: id, turnStart: next, mode })
  }

  const expandForReading = (start: number) => setTurnStart(start, { mode: "reading" })
  const expandForHash = (start: number) => setTurnStart(start, { mode: "hash" })
  const markHashTarget = (index: number) => {
    const current = turnStart()
    expandForHash(index < current ? index : current)
  }
  const resumeLatestWindow = () =>
    setTurnStart(initialTurnStart(input.visibleUserMessages().length), { mode: "bottom" })
  const returnToLatestIfFollowing = () => {
    if (input.userScrolled()) return
    resumeLatestWindow()
  }
  const mode = () => state.mode

  const renderedUserMessages = createMemo(
    () => {
      const msgs = input.visibleUserMessages()
      const start = turnStart()
      if (start <= 0) return msgs
      return msgs.slice(start)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )

  const preserveScroll = (fn: () => void) => {
    const el = input.scroller()
    if (!el) {
      fn()
      return
    }
    const beforeTop = el.scrollTop
    const beforeHeight = el.scrollHeight
    fn()
    requestAnimationFrame(() => {
      const delta = el.scrollHeight - beforeHeight
      if (!delta) return
      el.scrollTop = beforeTop + delta
    })
  }

  const backfillTurns = () => {
    const start = turnStart()
    if (start <= 0) return

    const next = start - turnBatch
    const nextStart = next > 0 ? next : 0

    preserveScroll(() => expandForReading(nextStart))
  }

  /** Button path: reveal all cached turns, fetch older history, reveal one batch. */
  const loadAndReveal = async () => {
    const id = input.sessionID()
    if (!id) return

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length
    let loaded = input.loaded()

    if (start > 0) expandForReading(0)

    if (!input.historyMore() || input.historyLoading()) return

    let afterVisible = beforeVisible
    let added = 0

    while (true) {
      await input.loadMore(id)
      if (input.sessionID() !== id) return

      afterVisible = input.visibleUserMessages().length
      const nextLoaded = input.loaded()
      const raw = nextLoaded - loaded
      added += raw
      loaded = nextLoaded

      if (afterVisible > beforeVisible) break
      if (raw <= 0) break
      if (!input.historyMore()) break
    }

    if (added <= 0) return
    if (state.prefetchNoGrowth) setState("prefetchNoGrowth", 0)

    const growth = afterVisible - beforeVisible
    if (growth <= 0) return
    if (turnStart() !== 0) return

    const target = Math.min(afterVisible, beforeVisible + turnBatch)
    expandForReading(Math.max(0, afterVisible - target))
  }

  /** Scroll/prefetch path: fetch older history from server. */
  const fetchOlderMessages = async (opts?: { prefetch?: boolean }) => {
    const id = input.sessionID()
    if (!id) return
    if (!input.historyMore() || input.historyLoading()) return

    if (opts?.prefetch) {
      const now = Date.now()
      if (state.prefetchUntil > now) return
      if (state.prefetchNoGrowth >= prefetchNoGrowthLimit) return
      setState("prefetchUntil", now + prefetchCooldownMs)
    }

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length
    const beforeRendered = start <= 0 ? beforeVisible : renderedUserMessages().length
    let loaded = input.loaded()
    let added = 0
    let growth = 0

    while (true) {
      await input.loadMore(id)
      if (input.sessionID() !== id) return

      const nextLoaded = input.loaded()
      const raw = nextLoaded - loaded
      added += raw
      loaded = nextLoaded
      growth = input.visibleUserMessages().length - beforeVisible

      if (growth > 0) break
      if (raw <= 0) break
      if (opts?.prefetch) break
      if (!input.historyMore()) break
    }

    const afterVisible = input.visibleUserMessages().length

    if (opts?.prefetch) {
      setState("prefetchNoGrowth", added > 0 ? 0 : state.prefetchNoGrowth + 1)
    } else if (added > 0 && state.prefetchNoGrowth) {
      setState("prefetchNoGrowth", 0)
    }

    if (added <= 0) return
    if (growth <= 0) return

    if (opts?.prefetch) {
      const current = turnStart()
      preserveScroll(() => expandForReading(current + growth))
      return
    }

    if (turnStart() !== start) return

    const currentRendered = renderedUserMessages().length
    const base = Math.max(beforeRendered, currentRendered)
    const target = Math.min(afterVisible, base + turnBatch)
    preserveScroll(() => expandForReading(Math.max(0, afterVisible - target)))
  }

  const onScrollerScroll = () => {
    if (!input.userScrolled()) return
    const el = input.scroller()
    if (!el) return
    if (el.scrollTop >= turnScrollThreshold) return

    const start = turnStart()
    if (start > 0) {
      if (start <= turnPrefetchBuffer) {
        void fetchOlderMessages({ prefetch: true })
      }
      backfillTurns()
      return
    }

    void fetchOlderMessages()
  }

  createEffect(
    on(
      input.sessionID,
      () => {
        setState({ prefetchUntil: 0, prefetchNoGrowth: 0, mode: "bottom" })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () =>
        [input.sessionID(), input.messagesReady(), input.visibleUserMessages().length, input.userScrolled()] as const,
      ([id, ready, len, userScrolled]) => {
        if (!id || !ready) return
        if (userScrolled && state.mode === "bottom") {
          setState("mode", "reading")
          return
        }
        if (!userScrolled && state.mode !== "bottom") {
          returnToLatestIfFollowing()
          return
        }
        returnToLatestIfFollowing()
      },
      { defer: true },
    ),
  )

  return {
    turnStart,
    setTurnStart,
    expandForReading,
    expandForHash,
    markHashTarget,
    resumeLatestWindow,
    returnToLatestIfFollowing,
    mode,
    renderedUserMessages,
    loadAndReveal,
    onScrollerScroll,
  }
}
