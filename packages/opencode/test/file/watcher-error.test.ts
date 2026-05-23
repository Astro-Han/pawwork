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
})
