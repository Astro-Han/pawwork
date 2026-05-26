import { describe, expect, test } from "bun:test"
import { FileWatcher } from "../../src/file/watcher"

describe("FileWatcher error handling", () => {
  test("recognizes FSEvents dropped-event errors as rescan signals", () => {
    expect(
      FileWatcher.isDroppedEventsError(
        new Error("Events were dropped by the FSEvents client. File system must be re-scanned."),
      ),
    ).toBe(true)
    expect(FileWatcher.isDroppedEventsError(new Error("permission denied"))).toBe(false)
  })

  test("publishes a trailing rescan after repeated dropped-event errors go quiet", () => {
    const published: string[] = []
    const scheduled: Array<() => void> = []
    const settled: FileWatcher.RescanIncidentSummary[] = []
    let now = 100
    const scheduler = FileWatcher.createRescanScheduler({
      publish: (directory) => {
        published.push(directory)
      },
      now: () => now,
      onIncidentSettled: (summary) => {
        settled.push(summary)
      },
      schedule: (callback) => {
        scheduled.push(callback)
      },
    })

    scheduler.request("/repo")
    now = 150
    scheduler.request("/repo")

    expect(published).toEqual(["/repo"])
    expect(scheduled).toHaveLength(1)

    now = 1_150
    scheduled[0]?.()

    expect(published).toEqual(["/repo"])
    expect(scheduled).toHaveLength(2)

    now = 2_150
    scheduled[1]?.()

    expect(published).toEqual(["/repo", "/repo"])
    expect(settled).toEqual([
      {
        directory: "/repo",
        request_count: 2,
        coalesced_count: 1,
        leading_published: true,
        trailing_published: true,
        quiet_ms: 1_000,
        duration_ms: 2_050,
      },
    ])
  })

  test("coalesces dropped-event errors that keep arriving at the quiet-window boundary", () => {
    const published: string[] = []
    const scheduled: Array<() => void> = []
    const scheduler = FileWatcher.createRescanScheduler({
      publish: (directory) => {
        published.push(directory)
      },
      schedule: (callback) => {
        scheduled.push(callback)
      },
    })

    scheduler.request("/repo")

    for (let index = 0; index < 6; index++) {
      scheduler.request("/repo")
      scheduled[index]?.()
    }

    scheduled[6]?.()

    expect(published).toEqual(["/repo", "/repo"])
  })

  test("keeps synchronous requests published during a trailing rescan", () => {
    const published: string[] = []
    const scheduled: Array<() => void> = []
    let scheduler: ReturnType<typeof FileWatcher.createRescanScheduler>
    scheduler = FileWatcher.createRescanScheduler({
      publish: (directory) => {
        published.push(directory)
        if (published.length === 2) scheduler.request(directory)
      },
      schedule: (callback) => {
        scheduled.push(callback)
      },
    })

    scheduler.request("/repo")
    scheduler.request("/repo")

    scheduled[0]?.()
    scheduled[1]?.()
    scheduled[2]?.()

    expect(published).toEqual(["/repo", "/repo", "/repo"])
  })

  test("does not publish queued trailing rescans after dispose", () => {
    const published: string[] = []
    const scheduled: Array<() => void> = []
    const scheduler = FileWatcher.createRescanScheduler({
      publish: (directory) => {
        published.push(directory)
      },
      schedule: (callback) => {
        scheduled.push(callback)
      },
    })

    scheduler.request("/repo")
    scheduler.request("/repo")
    scheduler.dispose()

    scheduled[0]?.()

    expect(published).toEqual(["/repo"])
  })
})
