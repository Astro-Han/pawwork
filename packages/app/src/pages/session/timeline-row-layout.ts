import type { TimelineRowRenderMode } from "./timeline-virtualization-strategy"

const inactivePlainMessageRowStyle = {
  "content-visibility": "auto",
  "contain-intrinsic-size": "auto 500px",
} as const

export function timelineMessageRowStyle(input: { mode: TimelineRowRenderMode; active: boolean }) {
  if (input.mode !== "plain") return undefined
  return input.active ? undefined : inactivePlainMessageRowStyle
}
