import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { Icon, type IconName } from "./icon"
import "./session-turn-trow-block.css"

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
// Component
// ============================================================================

export interface TrowBlockLabels {
  /** "正在运行 {count} 条命令" / "Running {count} commands" */
  summaryRunning: (count: number) => string
  /** "已运行 {count} 条命令" / "Ran {count} commands" */
  summaryCompleted: (count: number) => string
  /** "已运行 {count} 条命令，{failed} 条失败" / "Ran {count} commands, {failed} failed" */
  summaryWithFailed: (count: number, failed: number) => string
}

export interface TrowBlockProps {
  parts: ToolPart[]
  /** Default open state — DESIGN.md L468 locks default-collapsed (false). */
  defaultOpen?: boolean
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
  /** Caller-resolved summary labels. */
  labels: TrowBlockLabels
  /**
   * Caller-provided per-tool renderer. The shell wires this to the existing
   * `<Part>` / `<GenericTool>` / `<BasicTool>` paths from message-part.tsx so
   * each individual tool keeps its current rich body. When `renderTool` is
   * omitted, the block falls back to a minimal "name + status" row.
   */
  renderTool?: (part: ToolPart) => JSX.Element
}

/**
 * Slice 11b.1 trow-block — one row that summarises a group of consecutive
 * tool calls produced by `groupParts()`, with a native `<details>` body
 * that lists each tool. DESIGN.md L412-L417 / L471, design doc §3.1 / §3.6.
 *
 * Default-collapsed (DESIGN.md L468). Summary copy switches between
 * running / completed / failed based on the pure {@link reduceTrowBlock}
 * derivation. The summary shimmer (slot exposes a `data-running` attribute
 * the CSS can target) signals live state without an extra spinner.
 *
 * Per-tool rich rendering (file accordion, raw output, copy button on
 * hover) is intentionally delegated to a caller-provided slot — the
 * SessionTurn shell wires the existing message-part renderers in. This
 * keeps slice 11b.1 from reimplementing 11a's tool body logic and keeps
 * the component context-free for unit testing.
 */
export function TrowBlock(props: TrowBlockProps) {
  const summary = createMemo(() => reduceTrowBlock(props.parts))
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)

  const summaryText = createMemo(() => {
    const s = summary()
    if (s.running) return props.labels.summaryRunning(s.count)
    if (s.failedCount > 0) return props.labels.summaryWithFailed(s.count, s.failedCount)
    return props.labels.summaryCompleted(s.count)
  })

  // Suppress the chev (and the disclosure affordance) when no tool in the
  // group has any per-row body worth expanding. We approximate this by
  // checking that every part has either `state.output` (completed) or an
  // `error` (errored) — pending / running tools alone do not earn a chev
  // (matches W1 preview's "无中间输出的工具 summary 不渲染 chev" rule).
  const hasExpandableBody = createMemo(() => {
    return props.parts.some((part) => {
      const state = part.state
      if (state.status === "completed") return !!state.output
      if (state.status === "error") return true
      return false
    })
  })

  return (
    <div
      data-component="session-turn-trow-block"
      data-running={summary().running || undefined}
      data-failed={summary().failedCount > 0 || undefined}
    >
      <details
        open={open()}
        onToggle={(event) => {
          const el = event.currentTarget as HTMLDetailsElement
          setOpen(el.open)
        }}
      >
        <summary data-slot="trow-summary">
          <span data-slot="trow-summary-icon">
            <Icon name={summary().leadingIcon} />
          </span>
          <span data-slot="trow-summary-text">{summaryText()}</span>
          <Show when={hasExpandableBody()}>
            <span data-slot="trow-summary-chev" aria-hidden="true">
              <Icon name="chevron-down" />
            </span>
          </Show>
        </summary>
        <div data-slot="trow-body">
          {/*
           * `<For>` is the outer reactive primitive so the body stays in
           * sync with `props.parts` while the round is streaming. Earlier
           * iterations of this file wrapped the fallback path in a
           * `<Show fallback={defaultRenderTools(props.parts)}>` form,
           * which captured the parts array at creation time and would
           * not pick up new tool calls landing mid-stream.
           */}
          <For each={props.parts}>
            {(part) => (
              <Show when={props.renderTool} fallback={renderDefaultToolItem(part)}>
                <div data-slot="trow-item">{props.renderTool?.(part)}</div>
              </Show>
            )}
          </For>
        </div>
      </details>
    </div>
  )
}

/**
 * Fallback per-tool renderer used when the caller does not provide a
 * richer `renderTool` slot. Surfaces just the tool's name + status —
 * enough for unit / story tests but not the production body (the shell
 * wires the rich renderer).
 */
function renderDefaultToolItem(part: ToolPart): JSX.Element {
  return (
    <div data-slot="trow-item" data-status={part.state.status}>
      <span data-slot="trow-item-name">{part.tool}</span>
      <span data-slot="trow-item-status">{part.state.status}</span>
    </div>
  )
}
