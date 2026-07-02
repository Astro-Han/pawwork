export type ReviewChangeMode = "git" | "branch" | "turn"
export type VcsReviewMode = Exclude<ReviewChangeMode, "turn">

export const DEFAULT_REVIEW_CHANGE_MODE: ReviewChangeMode = "turn"

export const isVcsReviewMode = (mode: ReviewChangeMode): mode is VcsReviewMode =>
  mode === "git" || mode === "branch"

export const reviewChangeOptions = (input: { isGit: boolean }): ReviewChangeMode[] => {
  if (!input.isGit) return [DEFAULT_REVIEW_CHANGE_MODE]
  return ["git", "branch", DEFAULT_REVIEW_CHANGE_MODE]
}

export const coerceReviewChangeMode = (
  mode: ReviewChangeMode,
  options: readonly ReviewChangeMode[],
): ReviewChangeMode => (options.includes(mode) ? mode : DEFAULT_REVIEW_CHANGE_MODE)

export const reviewModeLabelKey = (mode: ReviewChangeMode) => {
  if (mode === "git") return "ui.sessionReview.title.git"
  if (mode === "branch") return "ui.sessionReview.title.branch"
  return "ui.sessionReview.title.lastTurn"
}

export const nextReviewModeForSessionChange = () => DEFAULT_REVIEW_CHANGE_MODE

export const reviewDiffsForMode = <T>(
  mode: ReviewChangeMode,
  input: { turn: readonly T[]; vcs: Record<VcsReviewMode, readonly T[]> },
): readonly T[] => {
  if (isVcsReviewMode(mode)) return input.vcs[mode]
  return input.turn
}
