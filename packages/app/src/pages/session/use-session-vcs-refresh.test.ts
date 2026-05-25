import { describe, expect, test } from "bun:test"
import { isFileWatcherVcsRefreshEvent } from "./use-session-vcs-refresh"

describe("session vcs refresh watcher events", () => {
  test("refreshes for rescan, source updates, and git state updates", () => {
    expect(isFileWatcherVcsRefreshEvent({ type: "file.watcher.rescan", properties: { directory: "/repo" } })).toBe(true)

    for (const file of [
      "src/app.ts",
      ".git/index",
      ".git/HEAD",
      ".git/packed-refs",
      ".git/refs/heads/feature/test",
      ".git/refs/remotes/origin/dev",
      ".git/logs/HEAD",
      ".git/worktrees/review-worktree/gitdir",
      ".git\\refs\\heads\\feature\\test",
      "/repo/.git/index",
      "/repo/.git/HEAD",
      "C:\\repo\\.git\\refs\\heads\\feature\\test",
    ]) {
      expect(isFileWatcherVcsRefreshEvent({ type: "file.watcher.updated", properties: { file, event: "change" } })).toBe(
        true,
      )
    }

    for (const file of [
      ".git/objects/aa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ".git/refs/tags/v1.0.0",
      ".git/refs/stash",
      ".git/FETCH_HEAD",
      ".git/MERGE_HEAD",
      ".git/REVERT_HEAD",
      ".git/CHERRY_PICK_HEAD",
      "/repo/.git/objects/aa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "/repo/.git/refs/tags/v1.0.0",
      "C:\\repo\\.git\\objects\\aa\\bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]) {
      expect(isFileWatcherVcsRefreshEvent({ type: "file.watcher.updated", properties: { file, event: "change" } })).toBe(
        false,
      )
    }

    expect(isFileWatcherVcsRefreshEvent({ type: "session.updated", properties: {} })).toBe(false)
  })
})
