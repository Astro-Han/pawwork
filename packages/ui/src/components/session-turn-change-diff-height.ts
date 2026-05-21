import type { FileDiffMetadata } from "@pierre/diffs"

export const TURN_CHANGE_DIFF_LINE_HEIGHT = 24
export const TURN_CHANGE_DIFF_MAX_HEIGHT = 420
export const TURN_CHANGE_DIFF_MIN_HEIGHT = 48

const TURN_CHANGE_DIFF_RENDER_BUFFER_ROWS = 2

type DiffHeightSource = Pick<FileDiffMetadata, "additionLines" | "deletionLines">

export function clampTurnChangeDiffReservedHeight(height: number) {
  if (!Number.isFinite(height)) return TURN_CHANGE_DIFF_MIN_HEIGHT
  return Math.min(TURN_CHANGE_DIFF_MAX_HEIGHT, Math.max(TURN_CHANGE_DIFF_MIN_HEIGHT, Math.ceil(height)))
}

export function estimateTurnChangeDiffReservedHeight(diff: DiffHeightSource) {
  const changedLines = Math.max(diff.deletionLines.length, diff.additionLines.length, 1)
  return clampTurnChangeDiffReservedHeight(
    (changedLines + TURN_CHANGE_DIFF_RENDER_BUFFER_ROWS) * TURN_CHANGE_DIFF_LINE_HEIGHT,
  )
}
