import type { DesktopContext } from "@/utils/desktop-context"
import { describe, expect, test } from "bun:test"
import { createDesktopContextSync } from "./use-session-desktop-context"

const context: DesktopContext = {
  directory: "/repo",
  sessionID: "ses_1",
  route: "/repo/session/ses_1",
  locale: "en",
  title: "PawWork",
}

describe("desktop context sync", () => {
  test("does nothing when no sender exists", () => {
    const sync = createDesktopContextSync({
      maxRetries: 5,
      send: undefined,
      setTimer: () => {
        throw new Error("timer should not be scheduled")
      },
      clearTimer: () => undefined,
    })

    sync.push(context)
    sync.dispose()
  })

  test("deduplicates identical pending context", () => {
    let calls = 0
    const sync = createDesktopContextSync({
      maxRetries: 5,
      send: async () => {
        calls += 1
      },
      setTimer: () => 1,
      clearTimer: () => undefined,
    })

    sync.push(context)
    sync.push(context)

    expect(calls).toBe(1)
    sync.dispose()
  })

  test("schedules retry after a failed send", async () => {
    const timers: Array<() => void> = []
    let calls = 0
    const sync = createDesktopContextSync({
      maxRetries: 5,
      send: async () => {
        calls += 1
        throw new Error("transient failure")
      },
      setTimer: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimer: () => undefined,
    })

    sync.push(context)
    await Promise.resolve()
    await Promise.resolve()

    expect(calls).toBe(1)
    expect(timers).toHaveLength(1)

    sync.dispose()
  })
})
