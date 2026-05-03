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
    expect(source).toContain("historyWindow.returnToLatestIfFollowing()")
  })
})
