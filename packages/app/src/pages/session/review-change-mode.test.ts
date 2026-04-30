import { describe, expect, test } from "bun:test"
import {
  coerceReviewChangeMode,
  DEFAULT_REVIEW_CHANGE_MODE,
  isVcsReviewMode,
  nextReviewModeForSessionChange,
  reviewChangeOptions,
  reviewDiffsForMode,
  reviewModeLabelKey,
} from "./review-change-mode"

describe("review change mode", () => {
  test("defaults to last turn", () => {
    expect(DEFAULT_REVIEW_CHANGE_MODE).toBe("turn")
  })

  test("keeps all review modes selectable for git projects", () => {
    expect(reviewChangeOptions({ isGit: true })).toEqual(["unstaged", "staged", "branch", "turn"])
  })

  test("keeps branch selectable even when the branch diff is empty", () => {
    expect(reviewChangeOptions({ isGit: true })).toContain("branch")
  })

  test("limits non-git projects to last turn", () => {
    expect(reviewChangeOptions({ isGit: false })).toEqual(["turn"])
  })

  test("falls back to last turn when the selected mode is unavailable", () => {
    expect(coerceReviewChangeMode("branch", ["turn"])).toBe("turn")
  })

  test("identifies VCS-backed review modes", () => {
    expect(isVcsReviewMode("unstaged")).toBe(true)
    expect(isVcsReviewMode("staged")).toBe(true)
    expect(isVcsReviewMode("branch")).toBe(true)
    expect(isVcsReviewMode("turn")).toBe(false)
  })

  test("maps modes to translation keys", () => {
    expect(reviewModeLabelKey("unstaged")).toBe("ui.sessionReview.title.unstaged")
    expect(reviewModeLabelKey("staged")).toBe("ui.sessionReview.title.staged")
    expect(reviewModeLabelKey("branch")).toBe("ui.sessionReview.title.branch")
    expect(reviewModeLabelKey("turn")).toBe("ui.sessionReview.title.lastTurn")
  })

  test("resets session changes to last turn", () => {
    expect(nextReviewModeForSessionChange()).toBe("turn")
  })

  test("uses turn diffs without falling back to VCS diffs", () => {
    const turn = ["turn diff"]
    const vcs = {
      unstaged: ["unstaged diff"],
      staged: ["staged diff"],
      branch: ["branch diff"],
    }

    expect(reviewDiffsForMode("turn", { turn, vcs })).toEqual(turn)
  })

  test("keeps an empty last turn empty when VCS diffs exist", () => {
    const vcs = {
      unstaged: ["unstaged diff"],
      staged: ["staged diff"],
      branch: ["branch diff"],
    }

    expect(reviewDiffsForMode("turn", { turn: [], vcs })).toEqual([])
  })
})
