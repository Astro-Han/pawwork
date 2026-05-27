import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import type { ReasoningPart, ToolPart } from "@opencode-ai/sdk/v2"
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
      return "read-file"
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
      return "edit"
    case "todowrite":
      return "checklist"
    case "question":
      return "bubble-5"
    case "skill":
      return "skill"
    default:
      return "mcp"
  }
}

export type TrowPart = ToolPart | ReasoningPart

/**
 * Pure-derived state for a trow-block, computed from the immutable list of
 * parts that the {@link groupParts} grouping produced.
 */
export type TrowBlockSummary = {
  toolCount: number
  running: boolean
  failedCount: number
  leadingIcon: IconName
}

export function reduceTrowBlock(parts: readonly TrowPart[]): TrowBlockSummary {
  const tools = parts.filter((p): p is ToolPart => p.type === "tool")
  if (tools.length === 0) {
    return { toolCount: 0, running: false, failedCount: 0, leadingIcon: parts.some(p => p.type === "reasoning") ? "thinking" : "mcp" }
  }
  let running = false
  let failedCount = 0
  for (const tool of tools) {
    if (tool.state.status === "running" || tool.state.status === "pending") running = true
    if (tool.state.status === "error") failedCount += 1
  }
  return {
    toolCount: tools.length,
    running,
    failedCount,
    leadingIcon: toolFamilyIcon(tools[0]!.tool),
  }
}

export function activeTrowTool(parts: readonly TrowPart[], working = false): ToolPart | undefined {
  const tools = parts.filter((p): p is ToolPart => p.type === "tool")
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i]!
    if (tool.state.status === "running" || tool.state.status === "pending") return tool
  }
  if (!working || tools.length === 0) return undefined
  return tools[tools.length - 1]
}

export function activeReasoning(parts: readonly TrowPart[], working = false): boolean {
  if (!working) return false
  const last = parts[parts.length - 1]
  return last?.type === "reasoning"
}

export function trowPartHasExpandableBody(part: TrowPart): boolean {
  if (part.type === "reasoning") return !!part.text?.trim()
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

export function trowBlockAnchor(parts: readonly TrowPart[]): string {
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
  /** Label shown while the model is actively reasoning. */
  thinking?: string
}

export interface TrowBlockProps {
  parts: readonly TrowPart[]
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
  renderReasoning?: (part: ReasoningPart) => JSX.Element
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
  const toolParts = createMemo(() => props.parts.filter((p): p is ToolPart => p.type === "tool"))
  const summary = createMemo(() => reduceTrowBlock(props.parts))
  const activeTool = createMemo(() => activeTrowTool(props.parts, props.working))
  const isActiveReasoning = createMemo(() => activeReasoning(props.parts, props.working))
  const single = createMemo(() => props.parts.length === 1)
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)

  const summaryText = createMemo(() => {
    const s = summary()
    // Pure-reasoning block (no tool calls): always show the thinking label.
    if (s.toolCount === 0) return props.labels.thinking ?? ""
    if (isActiveReasoning() && props.labels.thinking) return props.labels.thinking
    const active = activeTool()
    const activeLabel = active ? props.describeTool?.(active) : undefined
    if (activeLabel) return activeLabel
    if (s.running) return props.labels.summaryRunning(s.toolCount)
    return props.labels.summaryCompleted(toolParts(), s.failedCount)
  })
  const leadingIcon = createMemo(() => {
    if (isActiveReasoning()) return "thinking" as IconName
    const active = activeTool()
    return active ? toolFamilyIcon(active.tool) : summary().leadingIcon
  })

  const hasExpandableBody = createMemo(() => props.parts.some(trowPartHasExpandableBody))
  const renderItem = (part: TrowPart) => {
    if (part.type === "reasoning") {
      if (!props.renderReasoning) return null
      return <div data-slot="trow-tool">{props.renderReasoning(part)}</div>
    }
    return (
      <Show when={props.renderTool} fallback={renderDefaultToolItem(part)}>
        <div data-slot="trow-tool">{props.renderTool?.(part)}</div>
      </Show>
    )
  }

  return (
    <div
      data-component="session-turn-trow-block"
      data-running={!!(activeTool() || isActiveReasoning()) || undefined}
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
                    <TextShimmer text={text()} active={!!(activeTool() || isActiveReasoning())} />
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
              <For each={props.parts}>{renderItem}</For>
            </div>
          </details>
        }
      >
        <div data-slot="trow-single-row" data-timeline-anchor={trowBlockAnchor(props.parts)}>
          <span data-slot="trow-summary-icon" aria-hidden="true">
            <Icon name={leadingIcon()} />
          </span>
          <div data-slot="trow-body">
            <For each={props.parts}>{renderItem}</For>
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
