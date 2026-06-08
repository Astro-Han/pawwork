import type { TimelineRowRenderMode } from "./timeline-virtualization-strategy"

export function timelineMessageRowStyle(_input: { mode: TimelineRowRenderMode; active: boolean }) {
  // Plain mode is capped to a small row count. Keep rows fully laid out so a
  // streamed row finishing active -> inactive cannot swap its real height for a
  // browser intrinsic-size estimate and move the scroll anchor.
  return undefined
}
