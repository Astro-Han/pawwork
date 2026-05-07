// 5-state right-slot status:
//   asking → busy → error → pin → time.
// pin sits below the three live signals (we never hide an active state
// behind a pin badge) but above the passive time stamp, so a pinned
// idle session reads as "pinned" instead of just a date.
// retry maps to busy upstream; interrupted falls through to time.
// Pure function so the row component stays declarative and the
// priority order is unit-testable.
export type SidebarStatusKind = "asking" | "busy" | "error" | "pin" | "time"

export interface SidebarStatusInput {
  asking: boolean
  busy: boolean
  error: boolean
  pinned: boolean
}

export function sidebarStatusKind(input: SidebarStatusInput): SidebarStatusKind {
  if (input.asking) return "asking"
  if (input.busy) return "busy"
  if (input.error) return "error"
  if (input.pinned) return "pin"
  return "time"
}
