import type { Part as PartType, ToolPart } from "@opencode-ai/sdk/v2"
import { PART_MAPPING } from "./message-part-registry"

/**
 * Slice 11b.1: legacy assistant grouping helpers extracted from
 * `message-part.tsx`. These power the still-existing `AssistantParts`
 * dispatcher path; the **new** prose / reasoning / trow-block grouping
 * for the W1 rewrite lives in a different file
 * (`./message-part-group.ts`) with a different return shape.
 *
 * Keep these two grouping modules separate — names look similar (both
 * own a `groupParts` symbol) but their semantics diverge:
 *
 *   `./message-part-group.ts`             v2 trow / prose / reasoning grouping
 *   `./message-part-render-groups.ts`     legacy context-tool grouping (this file)
 *
 * The legacy path will be removed once the v2 surface ships as the
 * default user-path in a sibling slice.
 */

// Tools intentionally hidden from rendering (handled inline elsewhere).
export const HIDDEN_TOOLS = new Set(["todowrite"])

// Tools that share a "context" group banner inside the legacy assistant
// dispatcher — they collapse into one ContextToolGroup row when adjacent.
export const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])

export function isContextGroupTool(part: PartType): part is ToolPart {
  return part.type === "tool" && CONTEXT_GROUP_TOOLS.has(part.tool)
}

export function list<T>(value: T[] | undefined | null, fallback: T[]) {
  if (Array.isArray(value)) return value
  return fallback
}

export function latestDefined<T>(value: () => T | undefined) {
  let latest: T | undefined
  return () => {
    const next = value()
    if (next !== undefined) latest = next
    return latest
  }
}

export function same<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

export type PartRef = {
  messageID: string
  partID: string
}

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "context"
      refs: PartRef[]
    }

export function sameRef(a: PartRef, b: PartRef) {
  return a.messageID === b.messageID && a.partID === b.partID
}

export function sameGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") {
    if (b.type !== "part") return false
    return sameRef(a.ref, b.ref)
  }
  if (b.type !== "context") return false
  if (a.refs.length !== b.refs.length) return false
  return a.refs.every((ref, i) => sameRef(ref, b.refs[i]!))
}

export function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]!))
}

/**
 * Legacy assistant grouping — collapses adjacent context tools (`read`
 * / `glob` / `grep` / `list`) into a single `context` group row; emits
 * standalone `part` rows for everything else. The grouper does NOT
 * filter — pass already-renderable parts only.
 */
export function groupParts(parts: { messageID: string; part: PartType }[]) {
  const result: PartGroup[] = []
  let start = -1

  const flush = (end: number) => {
    if (start < 0) return
    const first = parts[start]
    const last = parts[end]
    if (!first || !last) {
      start = -1
      return
    }
    result.push({
      key: `context:${first.part.id}`,
      type: "context",
      refs: parts.slice(start, end + 1).map((item) => ({
        messageID: item.messageID,
        partID: item.part.id,
      })),
    })
    start = -1
  }

  parts.forEach((item, idx) => {
    if (isContextGroupTool(item.part)) {
      if (start < 0) start = idx
      return
    }

    flush(idx - 1)
    result.push({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: {
        messageID: item.messageID,
        partID: item.part.id,
      },
    })
  })

  flush(parts.length - 1)
  return result
}

export function index<T extends { id: string }>(items: readonly T[]) {
  return new Map(items.map((item) => [item.id, item] as const))
}

export function renderable(part: PartType, showReasoningSummaries = true) {
  if (part.type === "tool") {
    if (HIDDEN_TOOLS.has(part.tool)) return false
    if (part.tool === "question") return part.state.status !== "pending" && part.state.status !== "running"
    return true
  }
  if (part.type === "text") return !!part.text?.trim()
  if (part.type === "reasoning") return showReasoningSummaries && !!part.text?.trim()
  return !!PART_MAPPING[part.type]
}

export function toolDefaultOpen(tool: string, shell = false, edit = false) {
  if (tool === "bash") return shell
  if (tool === "edit" || tool === "write" || tool === "apply_patch") return edit
}

export function partDefaultOpen(part: PartType, shell = false, edit = false) {
  if (part.type !== "tool") return
  return toolDefaultOpen(part.tool, shell, edit)
}
