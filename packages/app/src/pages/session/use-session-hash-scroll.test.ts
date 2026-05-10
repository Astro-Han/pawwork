import { describe, expect, test } from "bun:test"
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
    const source = await Bun.file(new URL("./use-session-hash-scroll.ts", import.meta.url)).text()

    expect(source).toContain("onMessageHashCleared")
    expect(source).toContain("input.onMessageHashCleared?.()")
  })

  test("timeline wires hash clearing to guarded latest-window recovery", async () => {
    const source = await Bun.file(new URL("./use-session-timeline-interaction.ts", import.meta.url)).text()

    expect(source).toContain("onMessageHashCleared")
    expect(source).toContain("historyWindow.clearHashTarget()")
  })

  test("timeline cancels bottom follow before hash or active-message navigation", async () => {
    const hashSource = await Bun.file(new URL("./use-session-hash-scroll.ts", import.meta.url)).text()
    const timelineSource = await Bun.file(new URL("./use-session-timeline-interaction.ts", import.meta.url)).text()
    const sessionSource = await Bun.file(new URL("../session.tsx", import.meta.url)).text()

    expect(hashSource).toContain("onMessageNavigation")
    expect(hashSource).toContain("input.onMessageNavigation?.(message.id)")
    expect(timelineSource).toContain("type: \"target_message\"")
    expect(timelineSource).toContain("const navigateMessageByOffset")
    expect(timelineSource).toContain("scrollDock.cancelBottomFollowLock()")
    expect(sessionSource).toContain("markScrollGesture: timelineInteraction.markScrollGesture")
    expect(sessionSource).toContain("navigateMessageByOffset: timelineInteraction.navigateMessageByOffset")
  })
})
