import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { patchFiles } from "./apply-patch-file"
import { Icon, type IconName } from "./icon"
import { TextShimmer } from "./text-shimmer"
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
    if (part.state.status === "running" || part.state.status === "pending") running = true
    if (part.state.status === "error") failedCount += 1
  }
  return {
    count: parts.length,
    running,
    failedCount,
    leadingIcon: toolFamilyIcon(parts[0]!.tool),
  }
}

export function activeTrowTool(parts: readonly ToolPart[], working = false): ToolPart | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!
    if (part.state.status === "running" || part.state.status === "pending") return part
  }
  if (!working || parts.length === 0) return undefined
  return parts[parts.length - 1]
}

export function trowPartHasExpandableBody(part: ToolPart): boolean {
  const state = part.state
  if (state.status === "error") return true
  if (state.status !== "completed") return false
  if (state.output) return true

  const input = state.input ?? {}
  const metadata = state.metadata ?? {}

  switch (part.tool) {
    case "question":
      return (
        metadata.dismissed === true ||
        Array.isArray(input.questions) &&
        input.questions.length > 0 &&
        Array.isArray(metadata.answers) &&
        metadata.answers.length > 0
      )
    case "edit":
      return (
        !!metadata.filediff ||
        (typeof input.filePath === "string" && (input.oldString != null || input.newString != null))
      )
    case "write":
      return typeof input.filePath === "string" && input.content != null
    case "apply_patch":
      return patchFiles(metadata.files).length > 0
    default:
      return false
  }
}

export function trowBlockAnchor(parts: readonly ToolPart[]): string {
  return `trow:${parts[0]?.id ?? "empty"}`
}

// ============================================================================
// Component
// ============================================================================

export interface TrowBlockLabels {
  /** Fallback running summary used only when no active tool label is available. */
  summaryRunning: (count: number) => string
  /** Caller-resolved completed summary, including any failure tail. */
  summaryCompleted: (parts: readonly ToolPart[], failedCount: number) => string
}

export interface TrowBlockProps {
  parts: readonly ToolPart[]
  /** Default open state — DESIGN.md L468 locks default-collapsed (false). */
  defaultOpen?: boolean
  /** Caller-resolved summary labels. */
  labels: TrowBlockLabels
  /**
   * Caller-provided per-tool renderer. The shell wires this to the existing
   * `<Part>` / `<GenericTool>` / `<BasicTool>` paths from message-part.tsx so
   * each individual tool keeps its current rich body. When `renderTool` is
   * omitted, the block falls back to a minimal "name + status" row.
   */
  renderTool?: (part: ToolPart) => JSX.Element
  working?: boolean
  describeTool?: (part: ToolPart) => string | undefined
}

/**
 * Slice 11b.1 trow-block — one row that summarises a group of consecutive
 * tool calls produced by `groupParts()`, with a native `<details>` body
 * that lists each tool. DESIGN.md L412-L417 / L471, design doc §3.1 / §3.6.
 *
 * Default-collapsed (DESIGN.md L468). The active row shows the current tool;
 * once the row is no longer active, the caller supplies the compact completed
 * summary. The summary shimmer (slot exposes a `data-running` attribute the
 * CSS can target) signals live state without an extra spinner.
 *
 * Per-tool rich rendering (file accordion, raw output, copy button on
 * hover) is intentionally delegated to a caller-provided slot — the
 * SessionTurn shell wires the existing message-part renderers in. This
 * keeps slice 11b.1 from reimplementing 11a's tool body logic and keeps
 * the component context-free for unit testing.
 */
export function TrowBlock(props: TrowBlockProps) {
  const summary = createMemo(() => reduceTrowBlock(props.parts))
  const activeTool = createMemo(() => activeTrowTool(props.parts, props.working))
  const single = createMemo(() => props.parts.length === 1)
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)

  const summaryText = createMemo(() => {
    const active = activeTool()
    const activeLabel = active ? props.describeTool?.(active) : undefined
    if (activeLabel) return activeLabel
    const s = summary()
    if (s.running) return props.labels.summaryRunning(s.count)
    return props.labels.summaryCompleted(props.parts, s.failedCount)
  })
  const leadingIcon = createMemo(() => {
    const active = activeTool()
    return active ? toolFamilyIcon(active.tool) : summary().leadingIcon
  })

  // Suppress the chev when no tool in the group has a visible expanded body.
  // Some renderers show details from input/metadata instead of state.output.
  const hasExpandableBody = createMemo(() => props.parts.some(trowPartHasExpandableBody))
  const renderToolItem = (part: ToolPart) => (
    <Show when={props.renderTool} fallback={renderDefaultToolItem(part)}>
      <div data-slot="trow-tool">{props.renderTool?.(part)}</div>
    </Show>
  )

  return (
    <div
      data-component="session-turn-trow-block"
      data-running={!!activeTool() || undefined}
      data-failed={summary().failedCount > 0 || undefined}
      data-single={single() || undefined}
    >
      <Show
        when={single()}
        fallback={
          <details
            open={open()}
            onToggle={(event) => {
              const el = event.currentTarget as HTMLDetailsElement
              setOpen(el.open)
            }}
          >
            <summary
              data-slot="trow-summary"
              data-timeline-anchor={trowBlockAnchor(props.parts)}
            >
              <span data-slot="trow-summary-icon">
                <Icon name={leadingIcon()} />
              </span>
              <Show when={summaryText()}>
                {(text) => (
                  <span data-slot="trow-summary-text">
                    <TextShimmer text={text()} active={!!activeTool()} />
                  </span>
                )}
              </Show>
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
              <For each={props.parts}>{renderToolItem}</For>
            </div>
          </details>
        }
      >
        <div data-slot="trow-single-row" data-timeline-anchor={trowBlockAnchor(props.parts)}>
          <span data-slot="trow-summary-icon" aria-hidden="true">
            <Icon name={leadingIcon()} />
          </span>
          <div data-slot="trow-body">
            <For each={props.parts}>{renderToolItem}</For>
          </div>
        </div>
      </Show>
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
