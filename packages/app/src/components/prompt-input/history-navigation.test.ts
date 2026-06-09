// Tests for directory-scoped prompt history (Task 3 of PR #750).
//
// We test the Persist.workspace target shape directly rather than calling
// createDirectoryHistoryStore(), because persisted() internally calls
// usePlatform() which requires a Solid reactive context that is not
// available in the bun:test environment.
//
// NOTE: The rAF stale-guard cannot be meaningfully tested in this unit-test
// layer because it requires a real DOM and a live Solid reactive root with
// directoryToken signals firing across animation frames.
// The E2E coverage for that branch is deferred to Task 10.

import { describe, expect, test } from "bun:test"
import { Persist, PersistTesting } from "@/utils/persist"
import { buildCommentByIDMap } from "./history-comment-map"

/** Mirrors the target-building logic in createDirectoryHistoryStore. */
function buildHistoryTarget(directory: string, mode: "normal" | "shell") {
  const key = mode === "shell" ? "prompt-history-shell" : "prompt-history"
  return Persist.workspace(directory, key)
  // No legacy keys — per v7, old global history is ignored.
}

describe("directory-scoped prompt history targets", () => {
  test("different directories produce different storage files", () => {
    const targetA = buildHistoryTarget("/home/user/project-a", "normal")
    const targetB = buildHistoryTarget("/home/user/project-b", "normal")

    expect(targetA.storage).not.toBe(targetB.storage)

    // Confirm against PersistTesting helper.
    expect(targetA.storage).toBe(PersistTesting.workspaceStorage("/home/user/project-a"))
    expect(targetB.storage).toBe(PersistTesting.workspaceStorage("/home/user/project-b"))
  })

  test("normal and shell modes share storage file but use distinct keys", () => {
    const normalTarget = buildHistoryTarget("/workspace/foo", "normal")
    const shellTarget = buildHistoryTarget("/workspace/foo", "shell")

    // Same directory → same file.
    expect(normalTarget.storage).toBe(shellTarget.storage)

    // Different mode → different key.
    expect(normalTarget.key).not.toBe(shellTarget.key)
    expect(normalTarget.key).toContain("prompt-history")
    expect(shellTarget.key).toContain("prompt-history-shell")
  })

  test("does NOT include legacy global history keys (v7: old global history is ignored)", () => {
    const normalTarget = buildHistoryTarget("/workspace/foo", "normal")
    const shellTarget = buildHistoryTarget("/workspace/foo", "shell")

    // Persist.workspace() with no legacy arg leaves it undefined.
    expect(normalTarget.legacy).toBeUndefined()
    expect(shellTarget.legacy).toBeUndefined()
  })

  test("workspace key uses workspace: prefix (Persist.workspace contract)", () => {
    const target = buildHistoryTarget("/my/dir", "normal")
    expect(target.key).toMatch(/^workspace:/)
  })

  test("storage file name encodes the directory path via checksum", () => {
    const dir = "/Users/someone/my-project"
    const target = buildHistoryTarget(dir, "normal")
    expect(target.storage).toBe(PersistTesting.workspaceStorage(dir))
  })

  test("two identical directories with identical modes produce identical targets", () => {
    const t1 = buildHistoryTarget("/same/dir", "shell")
    const t2 = buildHistoryTarget("/same/dir", "shell")
    expect(t1.storage).toBe(t2.storage)
    expect(t1.key).toBe(t2.key)
  })
})

// ---------------------------------------------------------------------------
// buildCommentByIDMap
// ---------------------------------------------------------------------------

type FakeComment = { file: string; id: string; selection: { start: number; end: number }; time: number; comment: string }

describe("buildCommentByIDMap", () => {
  const comments: FakeComment[] = [
    { file: "/a/foo.ts", id: "c-1", selection: { start: 1, end: 5 }, time: 1000, comment: "hello" },
    { file: "/a/bar.ts", id: "c-2", selection: { start: 2, end: 3 }, time: 2000, comment: "world" },
  ]

  test("returns populated map when comments exist", () => {
    const map = buildCommentByIDMap(comments)
    expect(map.size).toBe(2)
    // Key format: "${file}\n${id}"
    expect(map.has("/a/foo.ts\nc-1")).toBe(true)
    expect(map.has("/a/bar.ts\nc-2")).toBe(true)
    expect(map.get("/a/foo.ts\nc-1")?.selection.start).toBe(1)
  })

  test("returns empty map when no comments given", () => {
    const map = buildCommentByIDMap([])
    expect(map.size).toBe(0)
  })
})
