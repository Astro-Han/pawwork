// 5-state right-slot status:
//   asking → busy → error → unread → time.
// retry maps to busy upstream; interrupted falls through to time.
// asking outranks busy/error/unread because it hard-blocks the user (the
// agent is waiting for input). busy outranks unread because the spinning
// ring already says "wait", while a dot would invite the user to click
// into a still-running session. error outranks unread because errors
// need active handling and unread is a neutral nudge.
// Pinned sessions are signaled by their position in the "pinned"
// section header, not by a per-row badge — adding one would say the
// same thing twice.
// Pure function so the row component stays declarative and the
// priority order is unit-testable.
export type SidebarStatusKind = "asking" | "busy" | "error" | "unread" | "time"

export interface SidebarStatusInput {
  asking: boolean
  busy: boolean
  error: boolean
  unread: boolean
}

export function sidebarStatusKind(input: SidebarStatusInput): SidebarStatusKind {
  if (input.asking) return "asking"
  if (input.busy) return "busy"
  if (input.error) return "error"
  if (input.unread) return "unread"
  return "time"
}
