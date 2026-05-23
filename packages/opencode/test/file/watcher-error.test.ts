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

  test("publishes a trailing rescan when dropped-event errors repeat inside the dedupe window", () => {
    const published: string[] = []
    const scheduled: Array<() => void> = []
    const requestRescan = FileWatcher.createRescanScheduler({
      publish: (directory) => {
        published.push(directory)
      },
      schedule: (callback) => {
        scheduled.push(callback)
      },
    })

    requestRescan("/repo")
    requestRescan("/repo")

    expect(published).toEqual(["/repo"])
    expect(scheduled).toHaveLength(1)

    scheduled[0]?.()

    expect(published).toEqual(["/repo", "/repo"])
    expect(scheduled).toHaveLength(2)

    scheduled[1]?.()

    expect(published).toEqual(["/repo", "/repo"])
  })
})
