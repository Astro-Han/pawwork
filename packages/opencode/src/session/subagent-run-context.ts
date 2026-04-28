import { Context } from "effect"

/**
 * True only inside SubagentRun service writer methods. Read by Session.updatePart
 * to gate writes that mutate SubtaskPart lifecycle fields. Single shared module
 * keeps both writers and the guard observing the same Reference without a Layer wrapper.
 */
export const SubagentRunWriterContext: Context.Reference<boolean> = Context.Reference<boolean>(
  "@pawwork/SubagentRunWriterContext",
  { defaultValue: () => false },
)

// Includes both lifecycle state (status, timestamps, events, results) and immutable linkage
// fields (tool_call_id, parent_*_id, subagent_session_id). Linkage fields are set once at
// `start` / `patchSession` and must never be repointed: rewriting them would corrupt
// findLatestBySessionID, ownership checks, and the in-memory tool_call_id index.
const LIFECYCLE_KEYS = [
  "tool_call_id",
  "parent_session_id",
  "parent_message_id",
  "subagent_session_id",
  "status",
  "started_at",
  "updated_at",
  "ended_at",
  "consumed_at",
  "recent_events",
  "result_summary",
  "result_text",
  "partial_result",
  "error",
] as const

export class SubagentRunGuardViolation extends Error {
  readonly _tag = "SubagentRunGuardViolation"
  constructor(readonly tool_call_id: string | undefined) {
    super(`SubagentRun lifecycle field write outside writer context (tool_call_id=${tool_call_id ?? "?"})`)
    this.name = "SubagentRunGuardViolation"
  }
}

/**
 * Returns true if `next` mutates any lifecycle field relative to `existing`. Compares by value
 * (JSON.stringify) not by reference, so a static-field update that re-clones recent_events /
 * recent_events / error arrays/objects with identical content is NOT rejected. Only genuine
 * lifecycle mutations trip the guard.
 *
 * Caller contract: `existing` must be a real persisted part. First-write paths (no row yet)
 * are allowed unconditionally upstream — Session.fork / migration / import need to seed
 * historical lifecycle values without going through SubagentRun writers.
 *
 * Limitation: JSON.stringify is order-sensitive (`{a:1,b:2}` vs `{b:2,a:1}` produce different
 * strings) and drops `undefined` values. This is acceptable here because lifecycle field shapes
 * are produced by SubagentRun writers with stable key order, and `undefined` lifecycle fields
 * compare equal to `undefined` on both sides.
 */
export const lifecycleFieldsChanged = (
  existing: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean => {
  for (const k of LIFECYCLE_KEYS) {
    if (JSON.stringify(existing[k]) !== JSON.stringify(next[k])) return true
  }
  return false
}
