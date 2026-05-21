import { describe, expect, test } from "bun:test"
import { bindTimelineDriver, timelineEvent, timelineDriverEnabled, type TimelineWindow } from "./timeline"

describe("timeline e2e driver", () => {
  test("stays disabled outside explicit test runtime even when the window flag is set", () => {
    const win = { __opencode_e2e: { timeline: { enabled: true } } } as TimelineWindow

    expect(timelineDriverEnabled({ testRuntime: false, windowRef: win })).toBe(false)
  })

  test("requires the window flag inside explicit test runtime", () => {
    const win = { __opencode_e2e: { timeline: { enabled: true } } } as TimelineWindow

    expect(timelineDriverEnabled({ testRuntime: true, windowRef: win })).toBe(true)
    expect(timelineDriverEnabled({ testRuntime: true, windowRef: {} as TimelineWindow })).toBe(false)
  })

  test("binds the reveal listener inside the centralized test driver", () => {
    const listeners = new Map<string, (event: Event) => void>()
    const win = {
      __opencode_e2e: { timeline: { enabled: true } },
      addEventListener(name: string, handler: EventListener) {
        listeners.set(name, handler as (event: Event) => void)
      },
      removeEventListener(name: string, handler: EventListener) {
        if (listeners.get(name) === handler) listeners.delete(name)
      },
    } as unknown as TimelineWindow
    let reveals = 0

    const cleanup = bindTimelineDriver({
      testRuntime: true,
      timelineSessionID: () => "session-1",
      revealCached: () => {
        reveals += 1
      },
      windowRef: win,
    })

    listeners.get(timelineEvent)?.(new CustomEvent(timelineEvent, { detail: { action: "reveal-cached" } }))
    listeners.get(timelineEvent)?.(
      new CustomEvent(timelineEvent, { detail: { action: "reveal-cached", sessionID: "other-session" } }),
    )
    cleanup()

    expect(reveals).toBe(1)
    expect(listeners.has(timelineEvent)).toBe(false)
  })

  test("does not bind the listener outside explicit test runtime", () => {
    const listeners = new Map<string, EventListener>()
    const win = {
      __opencode_e2e: { timeline: { enabled: true } },
      addEventListener(name: string, handler: EventListener) {
        listeners.set(name, handler)
      },
      removeEventListener() {},
    } as unknown as TimelineWindow

    bindTimelineDriver({
      testRuntime: false,
      timelineSessionID: () => undefined,
      revealCached: () => {},
      windowRef: win,
    })

    expect(listeners.has(timelineEvent)).toBe(false)
  })
})
