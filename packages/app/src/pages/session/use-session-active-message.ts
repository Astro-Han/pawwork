import type { UserMessage } from "@opencode-ai/sdk/v2"
import { createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"

export function createSessionActiveMessage(input: {
  sessionKey: () => string
  visibleUserMessages: () => UserMessage[]
  lastUserMessageID: () => string | undefined
  scroller: () => HTMLElement | undefined
  resumeScroll: () => void
  pauseAutoScroll: () => void
}) {
  const [store, setStore] = createStore({
    messageId: undefined as string | undefined,
    pendingMessage: undefined as string | undefined,
    scrollGesture: 0,
  })
  let scrollMark = 0
  let messageMark = 0
  let scrollToMessage: (message: UserMessage, behavior: ScrollBehavior) => void = () => {}

  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    setStore("messageId", message?.id)
  }

  const cursor = () => {
    const root = input.scroller()
    if (!root) return store.messageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((el) => {
        const id = el.dataset.messageId
        if (!id) return

        const rect = el.getBoundingClientRect()
        return { id, top: rect.top, bottom: rect.bottom }
      })
      .filter((item): item is { id: string; top: number; bottom: number } => !!item)

    const shown = list.filter((item) => item.bottom > box.top && item.top < box.bottom)
    const hit = shown.find((item) => item.top <= line && item.bottom >= line)
    if (hit) return hit.id

    const near = [...shown].sort((a, b) => {
      const da = Math.abs(a.top - line)
      const db = Math.abs(b.top - line)
      if (da !== db) return da - db
      return a.top - b.top
    })[0]
    if (near) return near.id

    return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? store.messageId
  }

  const navigateMessageByOffset = (offset: number) => {
    const msgs = input.visibleUserMessages()
    if (msgs.length === 0) return

    const current = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      input.resumeScroll()
      return
    }

    input.pauseAutoScroll()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = input.scroller()
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setStore("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - store.scrollGesture < 250

  createEffect(
    on(
      input.lastUserMessageID,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      input.sessionKey,
      () => {
        setStore("messageId", undefined)
        setStore("pendingMessage", undefined)
      },
      { defer: true },
    ),
  )

  return {
    messageId: () => store.messageId,
    pendingMessage: () => store.pendingMessage,
    setPendingMessage: (value: string | undefined) => setStore("pendingMessage", value),
    setActiveMessage,
    clearActiveMessage: () => setStore("messageId", undefined),
    navigateMessageByOffset,
    markScrollGesture,
    hasScrollGesture,
    markUserScroll: () => {
      scrollMark += 1
    },
    setScrollToMessage: (next: (message: UserMessage, behavior: ScrollBehavior) => void) => {
      scrollToMessage = next
    },
  }
}
