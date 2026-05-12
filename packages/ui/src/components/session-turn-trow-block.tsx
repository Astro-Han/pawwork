import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { IconName } from "./icon"

// ============================================================================
// Pure reducer + tool-family icon map
// ============================================================================
//
// Kept at the top of this file as named exports so the reducer can be unit
// tested as a pure function (see session-turn-trow-block.reducer.test.ts).
// The Solid component below is a thin presentational shell that consumes
// these helpers — the testable logic lives here.
//
// The tool-family icon map is intentionally a subset of message-part.tsx's
// `getToolInfo()` switch — the trow-block leading icon only needs the icon
// name (no i18n title / subtitle), so we duplicate the mapping rather than
// pulling the whole i18n-coupled helper. When `getToolInfo()` adds a new
// tool kind, `toolFamilyIcon()` should be updated in lock-step; the unit
// test below pins the contract for the well-known tool families.

/**
 * Resolves a tool's family icon for the trow-block summary row.
 * Returns `mcp` (the generic MCP icon) for any unknown tool name —
 * matches `getToolInfo()`'s default branch.
 */
export function toolFamilyIcon(tool: string): IconName {
  switch (tool) {
    case "read":
      return "glasses"
    case "list":
      return "bullet-list"
    case "glob":
    case "grep":
      return "magnifying-glass-menu"
    case "webfetch":
    case "websearch":
      return "window-cursor"
    case "enter-worktree":
    case "exit-worktree":
      return "worktree"
    case "task":
    case "agent":
      return "agent"
    case "bash":
      return "console"
    case "edit":
    case "write":
    case "apply_patch":
      return "code-lines"
    case "todowrite":
      return "checklist"
    case "question":
      return "bubble-5"
    case "skill":
      return "brain"
    default:
      return "mcp"
  }
}

/**
 * Pure-derived state for a trow-block, computed from the immutable list of
 * `ToolPart`s that the {@link groupParts} grouping produced.
 *
 * - `count`: number of tools in the block.
 * - `running`: true when any part still has `state.status === "running"`.
 *   While `running`, the summary copy + shimmer signal a live operation.
 * - `failedCount`: tools with `state.status === "error"`. Used by §E14's
 *   grouped-failure summary copy.
 * - `leadingIcon`: family icon resolved from `parts[0].tool`. Empty input
 *   would never reach the reducer — `groupParts` never emits an empty
 *   trow-block — but defensive default returned for safety.
 */
export type TrowBlockSummary = {
  count: number
  running: boolean
  failedCount: number
  leadingIcon: IconName
}

export function reduceTrowBlock(parts: readonly ToolPart[]): TrowBlockSummary {
  if (parts.length === 0) {
    return { count: 0, running: false, failedCount: 0, leadingIcon: "mcp" }
  }
  let running = false
  let failedCount = 0
  for (const part of parts) {
    if (part.state.status === "running") running = true
    if (part.state.status === "error") failedCount += 1
  }
  return {
    count: parts.length,
    running,
    failedCount,
    leadingIcon: toolFamilyIcon(parts[0]!.tool),
  }
}

/**
 * i18n key for the summary copy line, given a reducer summary.
 *
 * - `session.trow.summary.running` — "正在运行 {count} 条命令" / "Running {count} commands"
 * - `session.trow.summary.withFailed` — "已运行 {count} 条命令，{failed} 条失败" / "Ran {count} commands, {failed} failed"
 * - `session.trow.summary.completed` — "已运行 {count} 条命令" / "Ran {count} commands"
 */
export function trowSummaryI18nKey(summary: TrowBlockSummary): string {
  if (summary.running) return "session.trow.summary.running"
  if (summary.failedCount > 0) return "session.trow.summary.withFailed"
  return "session.trow.summary.completed"
}

// ============================================================================
// Component (placeholder until Phase 2b fills the visual implementation)
// ============================================================================
//
// The render shell is intentionally minimal at this point — the reducer is
// the testable contract and ships first so the draft PR opens with the pure
// pieces ready for CodeRabbit. The W1 visual surface (chev rotation, expand
// animation, leading icon, shimmer on running, sub-item list) is wired in
// the Phase 2b commit.

export interface TrowBlockProps {
  parts: ToolPart[]
  defaultOpen?: boolean
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
}

export function TrowBlock(_props: TrowBlockProps) {
  // Filled in Phase 2b — see slice 11b.1 design doc §3.1 / §3.6 / DESIGN.md L471.
  return null
}
