import { describe, expect, test } from "bun:test"
import { deriveReviewArtifactFiles } from "./use-session-review-state"

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
})
