import type { FileDiffMetadata } from "@pierre/diffs"
import { parsePatch } from "diff"

export const TURN_CHANGE_DIFF_LINE_HEIGHT = 24
export const TURN_CHANGE_DIFF_MAX_HEIGHT = 420
export const TURN_CHANGE_DIFF_MIN_HEIGHT = 48

const TURN_CHANGE_DIFF_RENDER_BUFFER_ROWS = 2

type DiffHeightSource = Pick<FileDiffMetadata, "additionLines" | "deletionLines"> & { patch?: string }

export function clampTurnChangeDiffReservedHeight(height: number) {
  if (!Number.isFinite(height)) return TURN_CHANGE_DIFF_MIN_HEIGHT
  return Math.min(TURN_CHANGE_DIFF_MAX_HEIGHT, Math.max(TURN_CHANGE_DIFF_MIN_HEIGHT, Math.ceil(height)))
}

export function estimateTurnChangeDiffReservedHeight(diff: DiffHeightSource) {
  const changedLines =
    visibleUnifiedDiffLines(diff) ?? Math.max(diff.deletionLines.length + diff.additionLines.length, 1)
  return clampTurnChangeDiffReservedHeight(
    (changedLines + TURN_CHANGE_DIFF_RENDER_BUFFER_ROWS) * TURN_CHANGE_DIFF_LINE_HEIGHT,
  )
}

function visibleUnifiedDiffLines(diff: DiffHeightSource) {
  if (!diff.patch) return

  try {
    const patches = parsePatch(diff.patch)
    const visible = patches.reduce(
      (total, filePatch) => total + filePatch.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0),
      0,
    )
    return visible > 0 ? visible : undefined
  } catch {
    return
  }
}
