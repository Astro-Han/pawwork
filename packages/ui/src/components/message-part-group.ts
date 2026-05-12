import type { Part, ReasoningPart, TextPart, ToolPart } from "@opencode-ai/sdk/v2"

/**
 * Grouped render unit emitted by {@link groupParts}.
 *
 * - `prose` and `reasoning` carry a single text/reasoning part, kept as separate
 *   kinds so the renderer can pick distinct visuals (markdown body vs the
 *   `mf-reasoning` italic + `--fg-secondary` per DESIGN.md L482) while still
 *   sharing the same "flush boundary" role inside the grouping algorithm.
 * - `trow-block` carries one or more consecutive tool parts that share a
 *   logical operation — the boundary is implicit prose / reasoning between
 *   tool runs (DESIGN.md L466).
 */
export type PartGroup =
  | { kind: "prose"; partID: string; text: string }
  | { kind: "reasoning"; partID: string; text: string }
  | { kind: "trow-block"; parts: ToolPart[] }

const HIDDEN_TOOLS = new Set(["todowrite"])

/**
 * Pure, deterministic filter mirroring `message-part.tsx#renderable()` for the
 * three part kinds the grouper handles (tool / text / reasoning). Other SDK
 * part types (file, snapshot, step-start, agent, retry, …) intentionally
 * return `false` here — see §6.20: the grouper skips them silently rather
 * than emitting a prose-fallback or flushing the pending trow.
 */
function renderableForGrouping(part: Part): boolean {
  if (part.type === "tool") {
    if (HIDDEN_TOOLS.has(part.tool)) return false
    if (part.tool === "question") {
      return part.state.status !== "pending" && part.state.status !== "running"
    }
    return true
  }
  if (part.type === "text") return !!part.text?.trim()
  if (part.type === "reasoning") return !!part.text?.trim()
  return false
}

/**
 * Group an assistant message's parts into ordered render units.
 *
 * Algorithm (DESIGN.md L466, slice 11b.1 §3.1):
 *
 * 1. Iterate `parts` in order, skipping any part for which
 *    {@link renderableForGrouping} returns `false`.
 * 2. Consecutive renderable `tool` parts accumulate in a pending buffer.
 * 3. A renderable `text` or `reasoning` part **flushes** the buffer
 *    (emitting one `trow-block` if non-empty) and then emits its own
 *    `prose` / `reasoning` group. Prose interleaving IS the
 *    "logical operation" boundary in DESIGN.md L466.
 * 4. Any other part type is skipped silently — it does **not** flush
 *    the buffer and does **not** emit a group, so adjacent tool runs
 *    across an unknown / future part stay in the same trow-block.
 * 5. After the walk, any remaining buffered tools are flushed.
 *
 * The function is structural, deterministic, and free of timing /
 * callID heuristics so it can be unit-tested as a pure function.
 */
export function groupParts(parts: readonly Part[]): PartGroup[] {
  const groups: PartGroup[] = []
  let pendingTools: ToolPart[] = []

  const flushTools = () => {
    if (pendingTools.length > 0) {
      groups.push({ kind: "trow-block", parts: pendingTools })
      pendingTools = []
    }
  }

  for (const part of parts) {
    if (!renderableForGrouping(part)) {
      // Unknown / hidden / empty text — skip silently (see §6.20).
      // Important: do NOT flush, otherwise an interleaved hidden part
      // (e.g. todowrite) would visually split a logical tool run.
      continue
    }
    if (part.type === "tool") {
      pendingTools.push(part as ToolPart)
      continue
    }
    if (part.type === "text") {
      flushTools()
      const t = part as TextPart
      groups.push({ kind: "prose", partID: t.id, text: t.text })
      continue
    }
    if (part.type === "reasoning") {
      flushTools()
      const r = part as ReasoningPart
      groups.push({ kind: "reasoning", partID: r.id, text: r.text })
      continue
    }
    // Defensive: renderableForGrouping should have already rejected
    // anything we cannot route. If a new type slips through it is a
    // bug in renderableForGrouping — fall through silently.
  }

  flushTools()
  return groups
}
