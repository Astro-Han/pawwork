// 4-state right-slot status:
//   asking → busy → error → time.
// retry maps to busy upstream; interrupted falls through to time.
// Pinned sessions are signaled by their position in the "pinned"
// section header, not by a per-row badge — adding one would say the
// same thing twice.
// Pure function so the row component stays declarative and the
// priority order is unit-testable.
export type SidebarStatusKind = "asking" | "busy" | "error" | "time"

export interface SidebarStatusInput {
  asking: boolean
  busy: boolean
  error: boolean
}

export function sidebarStatusKind(input: SidebarStatusInput): SidebarStatusKind {
  if (input.asking) return "asking"
  if (input.busy) return "busy"
  if (input.error) return "error"
  return "time"
}
