import { describe, expect, test } from "bun:test"
import { isFileWatcherVcsRefreshEvent } from "./use-session-vcs-refresh"

describe("session vcs refresh watcher events", () => {
  test("refreshes for rescan, source updates, and git state updates", () => {
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
    ).toBe(true)
    expect(
      isFileWatcherVcsRefreshEvent({
        type: "file.watcher.updated",
        properties: { file: ".git/refs/heads/feature/test", event: "change" },
      }),
    ).toBe(true)
    expect(
      isFileWatcherVcsRefreshEvent({
        type: "file.watcher.updated",
        properties: { file: ".git/objects/aa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", event: "change" },
      }),
    ).toBe(false)
    expect(isFileWatcherVcsRefreshEvent({ type: "session.updated", properties: {} })).toBe(false)
  })
})
