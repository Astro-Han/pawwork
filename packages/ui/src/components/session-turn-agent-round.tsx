import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  type JSX,
} from "solid-js"
import type { AssistantMessage, Part, ReasoningPart, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { Icon } from "./icon"
import { groupParts, type PartGroup } from "./message-part-group"
import { SystemEvent } from "./session-turn-event"
import { TrowBlock, type TrowBlockLabels } from "./session-turn-trow-block"
import {
  computeElapsedSec,
  isInterrupted,
  selectFirstAssistant,
  selectLatestAssistant,
} from "./session-turn-agent-round-helpers"
import { Tooltip } from "./tooltip"
import "./session-turn-agent-round.css"

// Re-export the pure helpers so existing callers (tests, neighbour
// components) keep their `from "./session-turn-agent-round"` import path
// working. The helpers themselves live in a sibling .ts module so test
// runners don't pull the Kobalte tooltip chain on module load.
export { computeElapsedSec, isInterrupted, selectFirstAssistant, selectLatestAssistant }

/**
 * Slice 11b.1 agent round — DESIGN.md L463-L469, design doc §3.2 / §3.5 / §3.6.
 *
 * Renders one round of agent activity in the new flat-on-`--bg-base`
 * surface (no turn-frame wrapper). The visible elements are, top-down:
 *
 * 1. Working-time header — always-visible single caption line that
 *    ticks every second while the round is running and freezes at the
 *    final elapsed value when the round completes. Same DOM node
 *    across states; only the `.is-running` class on the wrap flips.
 *
 * 2. Grouped body — `groupParts()` (the pure helper shipped in Phase
 *    1a) splits the round's parts into `prose` / `reasoning` /
 *    `trow-block` units. Prose is rendered through a caller-provided
 *    `renderProse` slot (the shell wires the 11a MessageMarkdown
 *    renderer in). Reasoning renders inline-italic muted (DESIGN.md
 *    L482). Tool runs render through `<TrowBlock>`.
 *
 * 3. System event — when the round was interrupted, a single muted
 *    caption follows the last rendered part. Other event kinds are
 *    reserved by `SystemEventKind` but not wired in 11b.1.
 *
 * 4. Agent toolbar — hover-only meta (completion time) + actions
 *    ([Copy] [Fork]). While the round is running, the toolbar is
 *    fully suppressed (visibility hidden + pointer-events none +
 *    aria-hidden) so Tab cannot reach inert buttons mid-stream.
 *
 * The component is context-free. The shell pre-resolves i18n labels,
 * formats the working-time string, and wires SDK action handlers.
 */

export interface SessionTurnAgentRoundActions {
  /** Override the built-in `navigator.clipboard.writeText` path. */
  onCopy?: (text: string) => Promise<void> | void
  /** Caller-owned fork entry point. When undefined, the [Fork] button is hidden. */
  onFork?: () => Promise<void> | void
}

export interface SessionTurnAgentRoundProps {
  /** Round-level assistant messages (sorted by `time.created`). */
  assistantMessages: readonly AssistantMessage[]
  /** Parts indexed by assistant messageID. */
  partsByMessage: Record<string, readonly Part[]>
  /**
   * True when this round is the last assistant round in the session.
   * Only the latest round can keep ticking; older rounds whose
   * `time.completed` never landed are still treated as terminal once a
   * new user message starts the next round (design doc §3.2).
   */
  isLatestRound: boolean
  /** Locale for the toolbar completion time formatter. */
  locale?: string
  /**
   * Caller-resolved labels. `workingTime` is a function because the
   * tick value updates every second; everything else is a static string.
   */
  labels: {
    copy: string
    copied: string
    fork: string
    interrupted: string
    workingTime: (seconds: number) => string
    trow: TrowBlockLabels
  }
  /**
   * Caller-provided prose renderer. Lets the SessionTurn shell plug in
   * the 11a MessageMarkdown component (which owns paced streaming,
   * DOMPurify, etc.) without dragging it into this component's import
   * graph.
   */
  renderProse: (input: { messageID: string; partID: string; text: string }) => JSX.Element
  /**
   * Optional reasoning renderer override. Defaults to a plain italic
   * muted block — DESIGN.md L482 calls for `--fg-secondary` italic, but
   * the spec stops short of a markdown-on-reasoning requirement.
   */
  renderReasoning?: (input: { messageID: string; partID: string; text: string }) => JSX.Element
  actions?: SessionTurnAgentRoundActions
  /**
   * Caller-provided per-tool renderer threaded into every `<TrowBlock>`.
   * The shell wires this to the existing `<Part>` registry so each tool
   * keeps its rich body (file accordion / raw output / copy button)
   * without this leaf needing to import the message-part graph.
   */
  renderTool?: (part: ToolPart) => JSX.Element
  /**
   * When `false`, reasoning groups are dropped from the rendered output
   * so the round shows only prose + tool calls (matching the settings
   * toggle "显示推理摘要 / Show reasoning summaries"). Defaults to
   * `true`. AstroHan's fourth W1 retest (msg=ac13481a) flagged that the
   * toggle previously had no effect on the W1 path — `showThinking`
   * read the setting but reasoning rendering ignored it.
   */
  showReasoningSummaries?: boolean
  /**
   * Fires before the trow `<details>` toggles open/closed. Plumbed
   * down to every nested `<TrowBlock>` so the timeline owner can
   * flip the scroll controller to `reading_history` before the agent's
   * next `content_resize` lands. See `session-turn-trow-block.tsx`
   * `onUserLayoutInteraction` for the trigger surface.
   */
  onTrowLayoutInteraction?: () => void
}

// ============================================================================
// Component (pure helpers extracted to ./session-turn-agent-round-helpers.ts)
// ============================================================================

export function SessionTurnAgentRound(props: SessionTurnAgentRoundProps) {
  const firstAssistant = createMemo(() => selectFirstAssistant(props.assistantMessages))
  const latestAssistant = createMemo(() => selectLatestAssistant(props.assistantMessages))

  const startTime = createMemo(() => firstAssistant()?.time?.created)
  const endTime = createMemo(() => latestAssistant()?.time?.completed)

  const isRunning = createMemo(() => endTime() === undefined && props.isLatestRound)

  const [now, setNow] = createSignal(Date.now())

  // 1-Hz tick while running; document.hidden gate keeps the tick cheap
  // when the tab is in the background. visibilitychange listener
  // immediately refreshes `now` on focus return so the elapsed counter
  // doesn't show a stale value.
  createEffect(() => {
    if (!isRunning()) return
    const id = setInterval(() => {
      if (document.hidden) return
      setNow(Date.now())
    }, 1000)
    const onVisibility = () => {
      if (!document.hidden) setNow(Date.now())
    }
    document.addEventListener("visibilitychange", onVisibility)
    onCleanup(() => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", onVisibility)
    })
  })

  const elapsedSec = createMemo(() =>
    computeElapsedSec({
      startMs: startTime(),
      endMs: endTime(),
      nowMs: now(),
    }),
  )

  const completionTime = createMemo(() => {
    const completedAt = endTime()
    if (typeof completedAt !== "number") return undefined
    return new Intl.DateTimeFormat(props.locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(completedAt)
  })

  const completionTitle = createMemo(() => {
    const completedAt = endTime()
    if (typeof completedAt !== "number") return undefined
    return new Date(completedAt).toString()
  })

  // Flatten parts for grouping. The grouper splits across the whole
  // round so prose / reasoning between two adjacent assistant messages
  // still acts as a flush boundary.
  const flatParts = createMemo(() => {
    const out: Part[] = []
    for (const message of props.assistantMessages) {
      const parts = props.partsByMessage[message.id]
      if (!parts) continue
      for (const part of parts) out.push(part as Part)
    }
    return out
  })

  // Drop reasoning groups when the settings toggle is off. The grouper
  // is structural and does not know about user preferences; the W1
  // "显示推理摘要" toggle suppresses the COT body, leaving only prose
  // + tool calls plus the `Thinking…` placeholder that `SessionTurn`
  // renders during pre-first-visible-output.
  const groups = createMemo<PartGroup[]>(() => {
    const raw = groupParts(flatParts())
    if (props.showReasoningSummaries === false) {
      return raw.filter((g) => g.kind !== "reasoning")
    }
    return raw
  })

  const copyText = createMemo(() => {
    const pieces: string[] = []
    for (const group of groups()) {
      if (group.kind === "prose") pieces.push(group.text)
    }
    return pieces.join("\n\n")
  })

  const interrupted = createMemo(() => isInterrupted(props.assistantMessages))

  const [copied, setCopied] = createSignal(false)
  const [forking, setForking] = createSignal(false)

  const handleCopy = async () => {
    const text = copyText()
    if (!text) return
    try {
      if (props.actions?.onCopy) {
        await props.actions.onCopy(text)
      } else {
        await navigator.clipboard.writeText(text)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // §6.13 handled by caller toast; built-in path swallows.
    }
  }

  const handleFork = async () => {
    if (forking() || !props.actions?.onFork) return
    setForking(true)
    try {
      await props.actions.onFork()
    } finally {
      // The shell calls navigate() inside onFork; this component may
      // unmount before this fires. Solid signal writes after unmount
      // are no-ops (§6.14 unmount race).
      setForking(false)
    }
  }

  const defaultRenderReasoning = (input: { messageID: string; partID: string; text: string }) => (
    <div data-slot="agent-reasoning">{input.text}</div>
  )

  return (
    <div
      data-component="session-turn-agent-round"
      data-running={isRunning() || undefined}
    >
      <Show when={typeof startTime() === "number"}>
        <div data-slot="agent-working-time">{props.labels.workingTime(elapsedSec())}</div>
      </Show>

      <div data-slot="agent-body">
        <For each={groups()}>
          {(group) => (
            <Switch>
              <Match when={group.kind === "prose"}>
                <div data-slot="agent-prose">
                  {props.renderProse({
                    messageID: findMessageIDForPart(props.assistantMessages, props.partsByMessage, (group as Extract<PartGroup, { kind: "prose" }>).partID),
                    partID: (group as Extract<PartGroup, { kind: "prose" }>).partID,
                    text: (group as Extract<PartGroup, { kind: "prose" }>).text,
                  })}
                </div>
              </Match>
              <Match when={group.kind === "reasoning"}>
                {(props.renderReasoning ?? defaultRenderReasoning)({
                  messageID: findMessageIDForPart(props.assistantMessages, props.partsByMessage, (group as Extract<PartGroup, { kind: "reasoning" }>).partID),
                  partID: (group as Extract<PartGroup, { kind: "reasoning" }>).partID,
                  text: (group as Extract<PartGroup, { kind: "reasoning" }>).text,
                })}
              </Match>
              <Match when={group.kind === "trow-block"}>
                <TrowBlock
                  parts={(group as Extract<PartGroup, { kind: "trow-block" }>).parts}
                  labels={props.labels.trow}
                  renderTool={props.renderTool}
                  onUserLayoutInteraction={props.onTrowLayoutInteraction}
                />
              </Match>
            </Switch>
          )}
        </For>
      </div>

      <Show when={interrupted()}>
        <SystemEvent kind="interrupted" label={props.labels.interrupted} />
      </Show>

      <div
        data-slot="agent-toolbar"
        aria-hidden={isRunning() || undefined}
      >
        <Show when={completionTime()}>
          <div data-slot="agent-toolbar-meta">
            <span data-slot="agent-toolbar-time" title={completionTitle()}>
              {completionTime()}
            </span>
          </div>
        </Show>
        <div data-slot="agent-toolbar-actions">
          {/* Tooltips surface the same i18n label that drives aria-label so the
              hover affordance is consistent with the keyboard a11y path. */}
          <Tooltip value={copied() ? props.labels.copied : props.labels.copy} placement="top" gutter={4}>
            <button
              type="button"
              data-slot="agent-toolbar-action"
              data-action="copy"
              data-copied={copied() || undefined}
              aria-label={copied() ? props.labels.copied : props.labels.copy}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void handleCopy()}
            >
              <Icon name={copied() ? "check" : "copy"} />
            </button>
          </Tooltip>
          <Show when={props.actions?.onFork}>
            <Tooltip value={props.labels.fork} placement="top" gutter={4}>
              <button
                type="button"
                data-slot="agent-toolbar-action"
                data-action="fork"
                disabled={forking()}
                aria-disabled={forking() || undefined}
                aria-label={props.labels.fork}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void handleFork()}
              >
                <Icon name="fork" />
              </button>
            </Tooltip>
          </Show>
        </div>
      </div>
    </div>
  )
}

/**
 * Resolves which messageID a given partID belongs to so the prose
 * renderer can request the right message context. Linear scan is
 * intentional — rounds rarely exceed a handful of assistant messages.
 */
function findMessageIDForPart(
  messages: readonly AssistantMessage[],
  partsByMessage: Record<string, readonly Part[]>,
  partID: string,
): string {
  for (const message of messages) {
    const parts = partsByMessage[message.id]
    if (!parts) continue
    if (parts.some((p) => p.id === partID)) return message.id
  }
  return messages[messages.length - 1]?.id ?? ""
}
