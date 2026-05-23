import { describe, expect, test } from "bun:test"
import { isFileWatcherVcsRefreshEvent } from "./use-session-vcs-refresh"

describe("session vcs refresh watcher events", () => {
  test("refreshes for rescan and non-git file updates only", () => {
    expect(isFileWatcherVcsRefreshEvent({ type: "file.watcher.rescan", properties: { directory: "/repo" } })).toBe(true)
    expect(
      isFileWatcherVcsRefreshEvent({
        type: "file.watcher.updated",
        properties: { file: "src/app.ts", event: "change" },
      }),
    ).toBe(true)
    expect(
      isFileWatcherVcsRefreshEvent({
        type: "file.watcher.updated",
        properties: { file: ".git/index", event: "change" },
      }),
    ).toBe(false)
    expect(isFileWatcherVcsRefreshEvent({ type: "session.updated", properties: {} })).toBe(false)
  })
})
