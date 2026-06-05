import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSessionHashScroll } from "./use-session-hash-scroll-core"
import { messageIdFromHash } from "./message-id-from-hash"
import { createTimelineScrollCommandSink } from "./timeline-scroll-command-sink"

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

  test("timeline leaves follow mode before hash or active-message navigation", async () => {
    const hashSource = await Bun.file(new URL("./use-session-hash-scroll-core.ts", import.meta.url)).text()
    const timelineSource = await Bun.file(new URL("./use-session-timeline-interaction.ts", import.meta.url)).text()
    const sessionSource = await Bun.file(new URL("../session.tsx", import.meta.url)).text()

    expect(hashSource).toContain("onMessageNavigation")
    expect(hashSource).toContain("input.onMessageNavigation?.(message.id)")
    // Hash navigation issues a target_message intent (which leaves follow mode),
    // and keyboard navigation pauses auto-follow via the reconciler.
    expect(timelineSource).toContain('type: "target_message"')
    expect(timelineSource).toContain("const navigateMessageByOffset")
    expect(timelineSource).toContain("const pauseFollow = () => reconciler.cancel()")
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
    const scrollCommandSink = createTimelineScrollCommandSink({ now: () => 300 })

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
          scrollCommandSink,
          onMessageNavigation: (messageID) => navigationCalls.push(messageID),
        },
        { hash: "#message-msg_2", pathname: "/session/ses_1", search: "" },
        () => undefined,
      )

      hashScroll.applyHash("auto")
      return dispose
    })

    expect(scrollPositions).toEqual([{ top: 160, behavior: "auto" }])
    expect(scrollCommandSink.records()).toEqual([
      expect.objectContaining({
        monotonicMs: 300,
        type: "hash-target",
        source: "use-session-hash-scroll-core/scrollToElement",
        method: "scroll-to",
        top: 160,
      }),
    ])
    expect(activeMessages).toEqual(["msg_2"])
    expect(markedTargets).toEqual([1])
    expect(navigationCalls).toEqual(["msg_2"])

    dispose()
    root.remove()
  })

  test("hash navigation bounds virtualizer reveal retries when the target never mounts", () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
    const frameCallbacks: FrameRequestCallback[] = []
    let nextFrameId = 1
    const revealCalls: string[] = []
    const root = document.createElement("div")

    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return nextFrameId++
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame

    let dispose: (() => void) | undefined
    try {
      document.body.append(root)

      dispose = createRoot((dispose) => {
        const hashScroll = createSessionHashScroll(
          {
            sessionKey: () => "ses_1:/repo",
            sessionID: () => "ses_1",
            messagesReady: () => true,
            visibleUserMessages: () => [{ id: "msg_2" }] as any,
            historyMore: () => false,
            historyLoading: () => false,
            loadMore: async () => undefined,
            turnStart: () => 0,
            currentMessageId: () => undefined,
            pendingMessage: () => undefined,
            setPendingMessage: () => undefined,
            setActiveMessage: () => undefined,
            markHashTarget: () => undefined,
            autoScroll: { pause: () => undefined, forceScrollToBottom: () => undefined },
            scroller: () => root,
            anchor: (id) => `message-${id}`,
            scheduleScrollState: () => undefined,
            consumePendingMessage: () => undefined,
            virtualizerReveal: ({ messageID }) => {
              revealCalls.push(messageID)
              return true
            },
          },
          { hash: "#message-msg_2", pathname: "/session/ses_1", search: "" },
          () => undefined,
        )

        hashScroll.applyHash("auto")
        return dispose
      })

      for (let index = 0; index < 10; index += 1) {
        const callback = frameCallbacks.shift()
        if (!callback) break
        callback(index)
      }

      expect(revealCalls).toEqual(["msg_2", "msg_2", "msg_2", "msg_2"])
      expect(frameCallbacks).toHaveLength(0)
    } finally {
      dispose?.()
      root.remove()
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame
    }
  })
})
