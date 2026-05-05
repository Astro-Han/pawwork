import { describe, expect, test } from "bun:test"
import { deriveReviewArtifactFiles, shouldApplyVcsDiffResult } from "./use-session-review-state"

describe("session review state", () => {
  test("uses session artifact history when it matches the visible session", () => {
    const files = deriveReviewArtifactFiles({
      directory: "/repo",
      sessionID: "ses_1",
      history: {
        sessionID: "ses_1",
        artifacts: [{ file: "report.md", kind: "added" }],
      },
      turnDiffs: [{ file: "fallback.md", status: "added" }],
    })

    expect(files.map((file) => file.path)).toContain("/repo/report.md")
    expect(files.map((file) => file.path)).not.toContain("/repo/fallback.md")
  })

  test("falls back while artifact history belongs to a previous execution directory", () => {
    const files = deriveReviewArtifactFiles({
      directory: "/repo-root",
      sessionID: "ses_1",
      history: {
        directory: "/repo-worktree",
        sessionID: "ses_1",
        artifacts: [{ file: "stale.md", kind: "added" }],
      },
      turnDiffs: [{ file: "fallback.md", status: "added" }],
    })

    expect(files.map((file) => file.path)).toEqual(["/repo-root/fallback.md"])
  })

  test("falls back to added and modified turn diffs", () => {
    const files = deriveReviewArtifactFiles({
      directory: "/repo",
      sessionID: "ses_1",
      history: { sessionID: "ses_2", artifacts: [{ file: "stale.md", kind: "added" }] },
      turnDiffs: [
        { file: "created.md", status: "added" },
        { file: "updated.md", status: "modified" },
        { file: "deleted.md", status: "deleted" },
      ],
    })

    expect(files.map((file) => file.path)).toEqual(["/repo/created.md", "/repo/updated.md"])
  })

  test("treats missing turn diffs as no files while a session is loading", () => {
    const files = deriveReviewArtifactFiles({
      directory: "/repo",
      sessionID: "ses_1",
      history: { sessionID: "ses_2", artifacts: [{ file: "stale.md", kind: "added" }] },
      turnDiffs: undefined,
    })

    expect(files).toEqual([])
  })

  test("does not throw before turn diffs arrive for the selected session", () => {
    expect(() =>
      deriveReviewArtifactFiles({
        directory: "/repo",
        sessionID: "ses_1",
        history: { sessionID: "ses_1", artifacts: [] },
        turnDiffs: undefined,
      }),
    ).not.toThrow()
  })

  test("rejects stale VCS diff results from a previous execution directory", () => {
    expect(
      shouldApplyVcsDiffResult({
        requestedDirectory: "/repo-worktree",
        currentDirectory: "/repo-root",
        requestedRun: 1,
        currentRun: 1,
      }),
    ).toBe(false)

    expect(
      shouldApplyVcsDiffResult({
        requestedDirectory: "/repo-root",
        currentDirectory: "/repo-root",
        requestedRun: 1,
        currentRun: 1,
      }),
    ).toBe(true)
  })
})
