import type { UserMessage } from "@opencode-ai/sdk/v2"
import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createSessionHistoryWindow } from "./use-session-history-window"

const userMessage = (id: number) =>
  ({
    id: `msg_${id}`,
    role: "user",
    time: { created: Date.now() },
  }) as UserMessage

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
        scroller: () => undefined,
      })

      expect(history.turnStart()).toBe(0)
      expect(history.renderedUserMessages().map((message) => message.id)).toEqual(
        messages.map((message) => message.id),
      )
      dispose()
    })
  })
})
