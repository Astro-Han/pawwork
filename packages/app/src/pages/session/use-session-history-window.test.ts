import type { UserMessage } from "@opencode-ai/sdk/v2"
import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSessionHistoryWindow, resolveHistoryTurnStart } from "./use-session-history-window"

const userMessage = (id: number) =>
  ({
    id: `msg_${id}`,
    role: "user",
    time: { created: Date.now() },
  }) as UserMessage

const userMessages = (count: number) => Array.from({ length: count }, (_, index) => userMessage(index))
const ids = (start: number, end: number) => Array.from({ length: end - start }, (_, index) => `msg_${start + index}`)

const createHarness = (input: { count: number; userScrolled?: boolean; atBottom?: boolean; historyMore?: boolean }) => {
  const [state, setState] = createSignal({
    count: input.count,
    userScrolled: input.userScrolled ?? false,
    atBottom: input.atBottom ?? !(input.userScrolled ?? false),
    historyMore: input.historyMore ?? false,
  })
  const history = createSessionHistoryWindow({
    sessionID: () => "ses_1",
    messagesReady: () => true,
    loaded: () => state().count,
    visibleUserMessages: () => userMessages(state().count),
    historyMore: () => state().historyMore,
    historyLoading: () => false,
    loadMore: async () => undefined,
    userScrolled: () => state().userScrolled,
    isAtBottom: () => state().atBottom,
    scroller: () => undefined,
  })

  return {
    history,
    setCount: (count: number) => {
      setState((prev) => ({ ...prev, count }))
    },
    setUserScrolled: (value: boolean) => {
      setState((prev) => ({ ...prev, userScrolled: value }))
    },
    setAtBottom: (value: boolean) => {
      setState((prev) => ({ ...prev, atBottom: value }))
    },
  }
}

describe("session history window extraction", () => {
  test("renders only the last ten messages for long sessions", () => {
    createRoot((dispose) => {
      const messages = Array.from({ length: 18 }, (_, index) => userMessage(index))
      const history = createSessionHistoryWindow({
        sessionID: () => "ses_1",
        messagesReady: () => true,
        loaded: () => messages.length,
        visibleUserMessages: () => messages,
        historyMore: () => false,
        historyLoading: () => false,
        loadMore: async () => undefined,
        userScrolled: () => false,
        isAtBottom: () => true,
        scroller: () => undefined,
      })

      expect(history.turnStart()).toBe(8)
      expect(history.renderedUserMessages().map((message) => message.id)).toEqual(
        messages.slice(8).map((message) => message.id),
      )
      dispose()
    })
  })

  test("renders all messages for short sessions", () => {
    createRoot((dispose) => {
      const messages = Array.from({ length: 7 }, (_, index) => userMessage(index))
      const history = createSessionHistoryWindow({
        sessionID: () => "ses_1",
        messagesReady: () => true,
        loaded: () => messages.length,
        visibleUserMessages: () => messages,
        historyMore: () => false,
        historyLoading: () => false,
        loadMore: async () => undefined,
        userScrolled: () => false,
        isAtBottom: () => true,
        scroller: () => undefined,
      })

      expect(history.turnStart()).toBe(0)
      expect(history.renderedUserMessages().map((message) => message.id)).toEqual(messages.map((message) => message.id))
      dispose()
    })
  })

  test("bottom mode keeps same-session rendered turns bounded as new turns append", () => {
    expect(resolveHistoryTurnStart({ mode: "bottom", storedTurnStart: 0, length: 25, userScrolled: false })).toBe(15)
  })

  test("bottom mode preserves storedTurnStart when user has scrolled inside rendered range", () => {
    expect(resolveHistoryTurnStart({ mode: "bottom", storedTurnStart: 15, length: 26, userScrolled: true })).toBe(15)
  })

  test("expanded history stays expanded when new turns append", () => {
    expect(resolveHistoryTurnStart({ mode: "reading", storedTurnStart: 0, length: 26, userScrolled: false })).toBe(0)
  })

  test("hash mode keeps the target rendered across appends", () => {
    expect(resolveHistoryTurnStart({ mode: "hash", storedTurnStart: 4, length: 31, userScrolled: false })).toBe(4)
  })

  test("hash mode is entered even when the target is already inside the rendered bottom window", () => {
    createRoot((dispose) => {
      const state = createHarness({ count: 30 })

      state.history.markHashTarget(24)
      state.setCount(40)

      expect(state.history.mode()).toBe("hash")
      expect(state.history.renderedUserMessages().map((message) => message.id)).toContain("msg_24")
      dispose()
    })
  })

  test("jump to latest returns to bottom mode and latest bounded window", () => {
    createRoot((dispose) => {
      const state = createHarness({ count: 30 })

      state.history.expandForReading(0)
      state.history.resumeLatestWindow()

      expect(state.history.mode()).toBe("bottom")
      expect(state.history.turnStart()).toBe(20)
      expect(state.history.renderedUserMessages().map((message) => message.id)).toEqual(ids(20, 30))
      dispose()
    })
  })

  test("manual scroll back to bottom returns to bottom mode and bounds later appends", () => {
    createRoot((dispose) => {
      const state = createHarness({ count: 30 })

      state.history.expandForReading(0)
      expect(state.history.mode()).toBe("reading")

      state.setUserScrolled(false)
      state.history.returnToLatestIfFollowing()
      state.setCount(40)
      state.history.returnToLatestIfFollowing()

      expect(state.history.mode()).toBe("bottom")
      expect(resolveHistoryTurnStart({ mode: "bottom", storedTurnStart: 20, length: 40, userScrolled: false })).toBe(30)
      dispose()
    })
  })

  test("reading mode returns to latest only when the viewport is actually at bottom", () => {
    createRoot((dispose) => {
      const state = createHarness({ count: 30, userScrolled: true, atBottom: false })

      state.history.expandForReading(0)
      state.setUserScrolled(false)
      state.setAtBottom(false)
      state.history.returnToLatestIfFollowing()

      expect(state.history.mode()).toBe("reading")

      state.setAtBottom(true)
      state.setCount(40)
      state.history.returnToLatestIfFollowing()

      expect(state.history.mode()).toBe("bottom")
      expect(resolveHistoryTurnStart({ mode: "bottom", storedTurnStart: 20, length: 40, userScrolled: false })).toBe(30)
      dispose()
    })
  })

  test("loadAndReveal does not collapse reading window before the viewport is at bottom", async () => {
    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const state = createHarness({ count: 30, userScrolled: false, atBottom: false, historyMore: true })

        void state.history.loadAndReveal().then(() => {
          state.setCount(40)

          expect(state.history.mode()).toBe("reading")
          expect(
            resolveHistoryTurnStart({ mode: "reading", storedTurnStart: 0, length: 40, userScrolled: false }),
          ).toBe(0)
          dispose()
          resolve()
        })
      })
    })
  })

  test("cleared hash target returns to bottom mode before later appends", () => {
    createRoot((dispose) => {
      const state = createHarness({ count: 30 })

      state.history.markHashTarget(12)
      expect(state.history.mode()).toBe("hash")

      state.setUserScrolled(false)
      state.history.returnToLatestIfFollowing()
      state.setCount(40)
      state.history.returnToLatestIfFollowing()

      expect(state.history.mode()).toBe("bottom")
      expect(resolveHistoryTurnStart({ mode: "bottom", storedTurnStart: 20, length: 40, userScrolled: false })).toBe(30)
      dispose()
    })
  })
})
