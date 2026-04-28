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

const LIFECYCLE_KEYS = [
  "status",
  "started_at",
  "updated_at",
  "ended_at",
  "consumed_at",
  "last_activity",
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
 * last_activity / error arrays/objects with identical content is NOT rejected. Only genuine
 * lifecycle mutations trip the guard.
 *
 * Limitation: JSON.stringify is order-sensitive (`{a:1,b:2}` vs `{b:2,a:1}` produce different
 * strings) and drops `undefined` values. This is acceptable here because lifecycle field shapes
 * are produced by SubagentRun writers with stable key order, and `undefined` lifecycle fields
 * are short-circuited above as "no change".
 */
export const lifecycleFieldsChanged = (
  existing: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): boolean => {
  if (!existing) {
    // First write of this part. Reject only if the writer set a non-default lifecycle value.
    for (const k of LIFECYCLE_KEYS) {
      const v = next[k]
      if (v === undefined) continue
      if (k === "status" && v === "completed") continue
      if (k === "recent_events" && Array.isArray(v) && v.length === 0) continue
      return true
    }
    return false
  }
  for (const k of LIFECYCLE_KEYS) {
    if (JSON.stringify(existing[k]) !== JSON.stringify(next[k])) return true
  }
  return false
}
