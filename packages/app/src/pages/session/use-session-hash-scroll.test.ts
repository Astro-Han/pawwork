import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSessionHashScroll } from "./use-session-hash-scroll-core"
import { messageIdFromHash } from "./message-id-from-hash"

describe("messageIdFromHash", () => {
  test("parses hash with leading #", () => {
    expect(messageIdFromHash("#message-abc123")).toBe("abc123")
  })

  test("parses raw hash fragment", () => {
    expect(messageIdFromHash("message-42")).toBe("42")
  })

  test("ignores non-message anchors", () => {
    expect(messageIdFromHash("#review-panel")).toBeUndefined()
  })
})

describe("useSessionHashScroll", () => {
  test("clearing a message hash notifies the timeline to leave hash history mode", async () => {
    const source = await Bun.file(new URL("./use-session-hash-scroll-core.ts", import.meta.url)).text()

    expect(source).toContain("onMessageHashCleared")
    expect(source).toContain("input.onMessageHashCleared?.()")
  })

  test("timeline wires hash clearing to guarded latest-window recovery", async () => {
    const source = await Bun.file(new URL("./use-session-timeline-interaction.ts", import.meta.url)).text()

    expect(source).toContain("onMessageHashCleared")
    expect(source).toContain("historyWindow.clearHashTarget()")
  })

  test("timeline cancels bottom follow before hash or active-message navigation", async () => {
    const hashSource = await Bun.file(new URL("./use-session-hash-scroll-core.ts", import.meta.url)).text()
    const timelineSource = await Bun.file(new URL("./use-session-timeline-interaction.ts", import.meta.url)).text()
    const sessionSource = await Bun.file(new URL("../session.tsx", import.meta.url)).text()

    expect(hashSource).toContain("onMessageNavigation")
    expect(hashSource).toContain("input.onMessageNavigation?.(message.id)")
    expect(timelineSource).toContain('type: "target_message"')
    expect(timelineSource).toContain("const navigateMessageByOffset")
    expect(timelineSource).toContain("scrollDock.cancelBottomFollowLock()")
    expect(sessionSource).toContain("markScrollGesture: timelineInteraction.markScrollGesture")
    expect(sessionSource).toContain("navigateMessageByOffset: timelineInteraction.navigateMessageByOffset")
  })

  test("hash navigation scrolls an already rendered message without duplicate fallback navigation", async () => {
    const root = document.createElement("div")
    const target = document.createElement("div")
    const scrollPositions: ScrollToOptions[] = []
    const navigationCalls: string[] = []
    const activeMessages: string[] = []
    const markedTargets: number[] = []

    root.id = "session-root"
    target.id = "message-msg_2"
    root.append(target)
    document.body.append(root)

    root.getBoundingClientRect = () => ({
      top: 0,
      bottom: 400,
      left: 0,
      right: 400,
      width: 400,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    target.getBoundingClientRect = () => ({
      top: 160,
      bottom: 220,
      left: 0,
      right: 400,
      width: 400,
      height: 60,
      x: 0,
      y: 160,
      toJSON: () => ({}),
    })
    root.scrollTo = (options?: ScrollToOptions | number) => {
      if (typeof options === "object") scrollPositions.push(options)
    }

    const dispose = createRoot((dispose) => {
      const [currentMessageId, setCurrentMessageId] = createSignal<string | undefined>()

      const hashScroll = createSessionHashScroll(
        {
          sessionKey: () => "ses_1:/repo",
          sessionID: () => "ses_1",
          messagesReady: () => true,
          visibleUserMessages: () => [{ id: "msg_1" }, { id: "msg_2" }] as any,
          historyMore: () => false,
          historyLoading: () => false,
          loadMore: async () => undefined,
          turnStart: () => 0,
          currentMessageId,
          pendingMessage: () => undefined,
          setPendingMessage: () => undefined,
          setActiveMessage: (message) => {
            activeMessages.push(message?.id ?? "")
            setCurrentMessageId(message?.id)
          },
          markHashTarget: (index) => markedTargets.push(index),
          autoScroll: { pause: () => undefined, forceScrollToBottom: () => undefined },
          scroller: () => root,
          anchor: (id) => `message-${id}`,
          scheduleScrollState: () => undefined,
          consumePendingMessage: () => undefined,
          onMessageNavigation: (messageID) => navigationCalls.push(messageID),
        },
        { hash: "#message-msg_2", pathname: "/session/ses_1", search: "" },
        () => undefined,
      )

      hashScroll.applyHash("auto")
      return dispose
    })

    expect(scrollPositions).toEqual([{ top: 160, behavior: "auto" }])
    expect(activeMessages).toEqual(["msg_2"])
    expect(markedTargets).toEqual([1])
    expect(navigationCalls).toEqual(["msg_2"])

    dispose()
    root.remove()
  })
})
