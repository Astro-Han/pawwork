import { describe, expect, test } from "bun:test"
import { vcsTaskKey } from "./execution-scope"
import { deriveReviewArtifactFiles, reviewTurnDiffsForSession } from "./use-session-review-state"

const scope = (directory = "/repo", epoch = 1) => ({ serverKey: "sidecar", directory, epoch })

describe("session review state", () => {
  test("uses session artifact history when it matches the visible session", () => {
    const files = deriveReviewArtifactFiles({
      currentScope: scope("/repo", 1),
      sessionID: "ses_1",
      history: {
        scope: scope("/repo", 1),
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
      currentScope: scope("/repo-root", 2),
      sessionID: "ses_1",
      history: {
        scope: scope("/repo-worktree", 1),
        sessionID: "ses_1",
        artifacts: [{ file: "stale.md", kind: "added" }],
      },
      turnDiffs: [{ file: "fallback.md", status: "added" }],
    })

    expect(files.map((file) => file.path)).toEqual(["/repo-root/fallback.md"])
  })

  test("falls back while artifact history belongs to an older execution epoch of the same directory", () => {
    const files = deriveReviewArtifactFiles({
      currentScope: scope("/repo", 3),
      sessionID: "ses_1",
      history: {
        scope: scope("/repo", 1),
        sessionID: "ses_1",
        artifacts: [{ file: "stale.md", kind: "added" }],
      },
      turnDiffs: [{ file: "fallback.md", status: "added" }],
    })

    expect(files.map((file) => file.path)).toEqual(["/repo/fallback.md"])
  })

  test("falls back to added and modified turn diffs", () => {
    const files = deriveReviewArtifactFiles({
      currentScope: scope("/repo", 1),
      sessionID: "ses_1",
      history: { scope: scope("/repo", 1), sessionID: "ses_2", artifacts: [{ file: "stale.md", kind: "added" }] },
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
      currentScope: scope("/repo", 1),
      sessionID: "ses_1",
      history: { scope: scope("/repo", 1), sessionID: "ses_2", artifacts: [{ file: "stale.md", kind: "added" }] },
      turnDiffs: undefined,
    })

    expect(files).toEqual([])
  })

  test("does not throw before turn diffs arrive for the selected session", () => {
    expect(() =>
      deriveReviewArtifactFiles({
        currentScope: scope("/repo", 1),
        sessionID: "ses_1",
        history: { scope: scope("/repo", 1), sessionID: "ses_1", artifacts: [] },
        turnDiffs: undefined,
      }),
    ).not.toThrow()
  })

  test("keys pending VCS diff tasks by execution scope and mode", () => {
    expect(vcsTaskKey(scope("/repo", 1), "unstaged")).not.toBe(vcsTaskKey(scope("/repo", 3), "unstaged"))
    expect(vcsTaskKey(scope("/repo", 3), "unstaged")).not.toBe(vcsTaskKey(scope("/repo", 3), "staged"))
  })

  test("does not reuse aggregate diffs across sessions or execution scopes", () => {
    const aggregate = {
      sessionID: "ses_1",
      scope: scope("/repo", 1),
      diffs: [{ file: "old-session.ts", patch: "", additions: 1, deletions: 0, status: "added" as const }],
    }
    const fallback = [{ file: "current-session.ts", patch: "", additions: 1, deletions: 0, status: "added" as const }]

    expect(
      reviewTurnDiffsForSession({
        currentScope: scope("/repo", 1),
        sessionID: "ses_2",
        aggregate,
        turnDiffs: fallback,
      }),
    ).toEqual(fallback)
    expect(
      reviewTurnDiffsForSession({
        currentScope: scope("/repo", 2),
        sessionID: "ses_1",
        aggregate,
        turnDiffs: fallback,
      }),
    ).toEqual(fallback)
  })
})
