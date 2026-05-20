import { describe, expect, test } from "bun:test"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { createRoot } from "solid-js"

describe("session auto scroll", () => {
  test("disables overflow anchoring before forcing the timeline to bottom", () => {
    createRoot((dispose) => {
      const el = document.createElement("div")
      let top = 500
      let anchorAtScroll = ""

      Object.defineProperties(el, {
        clientHeight: { value: 100, configurable: true },
        scrollHeight: { value: 1000, configurable: true },
        scrollTop: {
          configurable: true,
          get: () => top,
          set: (value) => {
            anchorAtScroll = el.style.overflowAnchor
            top = value
          },
        },
      })

      const autoScroll = createAutoScroll({
        working: () => true,
        overflowAnchor: "dynamic",
      })

      autoScroll.scrollRef(el)
      autoScroll.pause()
      el.style.overflowAnchor = "auto"

      expect(autoScroll.userScrolled()).toBe(true)
      expect(el.style.overflowAnchor).toBe("auto")

      autoScroll.forceScrollToBottom()

      expect(anchorAtScroll).toBe("none")
      expect(top).toBe(1000)

      dispose()
    })
  })

  test("routes timeline bottom-follow writes through the optional command executor", () => {
    createRoot((dispose) => {
      const el = document.createElement("div")
      let top = 500
      const commands: Array<{ top: number; reason: string; method: string; anchor: string }> = []

      Object.defineProperties(el, {
        clientHeight: { value: 100, configurable: true },
        scrollHeight: { value: 1000, configurable: true },
        scrollTop: {
          configurable: true,
          get: () => top,
          set: (value) => {
            top = value
          },
        },
      })

      const autoScroll = createAutoScroll({
        working: () => true,
        overflowAnchor: "dynamic",
        executeScrollCommand: (command) => {
          commands.push({
            top: command.top,
            reason: command.reason,
            method: command.method,
            anchor: command.element.style.overflowAnchor,
          })
          command.element.scrollTop = command.top
        },
      })

      autoScroll.scrollRef(el)
      autoScroll.pause()
      el.style.overflowAnchor = "auto"

      autoScroll.forceScrollToBottom("force-bottom")

      expect(commands).toEqual([{ top: 1000, reason: "force-bottom", method: "set-scroll-top", anchor: "none" }])
      expect(top).toBe(1000)

      dispose()
    })
  })
})
