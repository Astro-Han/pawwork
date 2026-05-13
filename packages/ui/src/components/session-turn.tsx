import {
  AssistantMessage,
  type SnapshotFileDiff,
  Message as MessageType,
  Part as PartType,
} from "@opencode-ai/sdk/v2/client"
import type { SessionStatus } from "@opencode-ai/sdk/v2"
import { useData } from "../context"
import { Binary } from "@opencode-ai/core/util/binary"
import { createMemo, createSignal, onCleanup, ParentProps, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { MessageDivider, type UserActions } from "./message-part"
import { Card } from "./card"
import { TextShimmer } from "./text-shimmer"
import { SessionRetry } from "./session-retry"
import { TextReveal } from "./text-reveal"
import { createAutoScroll } from "../hooks"
import { useI18n } from "../context/i18n"
import {
  hasTurnChangeActionHandler,
  hasVisibleTurnChanges,
  turnChangeAction,
  type TurnChangeDisplay,
  type TurnChangeFile,
} from "./session-turn-changes"
import { TurnChangesList } from "./session-turn-changes-list"
import { SessionTurnDiffsList } from "./session-turn-diffs-list"
import { heading, list, partState, same, unwrap } from "./session-turn-helpers"
import { SessionTurnUserBubble } from "./session-turn-user-bubble"
import { SessionTurnAgentRound } from "./session-turn-agent-round"
import { createSessionTurnLeafBridges } from "./session-turn-leaf-bridges"

/**
 * Slice 11b.1: session-turn shell rewritten per design doc §2a / §3.
 *
 * Phase 2b wired the W1 leaf components into the main user path:
 *   - `<SessionTurnUserBubble>` replaces the legacy user-side `<Message>`
 *     dispatcher. The cream bubble + radius-lg + attachment row + hover
 *     toolbar (DESIGN.md L453-L462) is now the default visual.
 *   - `<SessionTurnAgentRound>` replaces `<AssistantParts>` for the
 *     assistant side. It owns the flat agent surface + working-time
 *     header + trow-grouped tool runs + `<SystemEvent>` placement +
 *     hover-only toolbar with [Copy] [Fork] (DESIGN.md L463-L469).
 *   - The shell still owns turn-level orchestration that crosses both
 *     sides: error card, thinking shimmer, retry banner, turn-changes
 *     accordion, auto-scroll anchoring, and the compaction divider.
 *
 * `renderProse` and `renderTool` are caller-injected slots so the W1
 * leaf stays context-free; the shell wires them to `PacedMarkdown`
 * (paced streaming markdown) and the existing `<Part>` dispatcher
 * respectively, so per-tool rich bodies (file accordion, raw output,
 * copy buttons) keep working through the trow-block.
 *
 * Sibling modules:
 *   - `session-turn-user-bubble.tsx`   user-side W1 leaf
 *   - `session-turn-agent-round.tsx`   assistant-side W1 leaf
 *   - `session-turn-trow-block.tsx`    tool grouping (used by agent-round)
 *   - `session-turn-event.tsx`         system-event caption
 *   - `session-turn-changes-list.tsx`  post-turn changes accordion
 *   - `session-turn-diffs-list.tsx`    legacy diffs accordion fallback
 *   - `session-turn-helpers.ts`        pure helpers (heading, unwrap, …)
 */

export function SessionTurn(
  props: ParentProps<{
    sessionID: string
    messageID: string
    messages?: MessageType[]
    actions?: UserActions
    showReasoningSummaries?: boolean
    turnChanges?: Record<string, TurnChangeDisplay | null | undefined>
    turnChangeActions?: {
      undo?: (
        userMessageID: string,
        options?: { force?: boolean },
      ) => Promise<TurnChangeDisplay | undefined> | void
      redo?: (
        userMessageID: string,
        options?: { force?: boolean },
      ) => Promise<TurnChangeDisplay | undefined> | void
      openFile?: (path: string) => void
      showInFolder?: (path: string) => void
    }
    active?: boolean
    status?: SessionStatus
    onUserInteracted?: () => void
    classes?: {
      root?: string
      content?: string
      container?: string
    }
  }>,
) {
  const data = useData()
  const i18n = useI18n()

  const emptyMessages: MessageType[] = []
  const emptyParts: PartType[] = []
  const emptyAssistant: AssistantMessage[] = []
  const emptyDiffs: SnapshotFileDiff[] = []
  const emptyTurnFiles: TurnChangeFile[] = []
  const idle = { type: "idle" as const }

  const allMessages = createMemo(() => props.messages ?? list(data.store.message?.[props.sessionID], emptyMessages))

  const messageIndex = createMemo(() => {
    const messages = allMessages() ?? emptyMessages
    const result = Binary.search(messages, props.messageID, (m) => m.id)

    const index = result.found ? result.index : messages.findIndex((m) => m.id === props.messageID)
    if (index < 0) return -1

    const msg = messages[index]
    if (!msg || msg.role !== "user") return -1

    return index
  })

  const message = createMemo(() => {
    const index = messageIndex()
    if (index < 0) return undefined

    const messages = allMessages() ?? emptyMessages
    const msg = messages[index]
    if (!msg || msg.role !== "user") return undefined

    return msg
  })

  const pending = createMemo(() => {
    if (typeof props.active === "boolean") return
    const messages = allMessages() ?? emptyMessages
    return messages.findLast(
      (item): item is AssistantMessage => item.role === "assistant" && typeof item.time.completed !== "number",
    )
  })

  const pendingUser = createMemo(() => {
    const item = pending()
    if (!item?.parentID) return
    const messages = allMessages() ?? emptyMessages
    const result = Binary.search(messages, item.parentID, (m) => m.id)
    const msg = result.found ? messages[result.index] : messages.find((m) => m.id === item.parentID)
    if (!msg || msg.role !== "user") return
    return msg
  })

  const active = createMemo(() => {
    if (typeof props.active === "boolean") return props.active
    const msg = message()
    const parent = pendingUser()
    if (!msg || !parent) return false
    return parent.id === msg.id
  })

  const parts = createMemo(() => {
    const msg = message()
    if (!msg) return emptyParts
    return list(data.store.part?.[msg.id], emptyParts)
  })

  const compaction = createMemo(() => parts().find((part) => part.type === "compaction"))

  const diffs = createMemo(() => {
    const files = message()?.summary?.diffs
    if (!files?.length) return emptyDiffs

    const seen = new Set<string>()
    return files
      .reduceRight<SnapshotFileDiff[]>((result, diff) => {
        if (seen.has(diff.file)) return result
        seen.add(diff.file)
        result.push(diff)
        return result
      }, [])
      .reverse()
  })
  const MAX_FILES = 10
  const edited = createMemo(() => diffs().length)
  const [state, setState] = createStore({
    showAll: false,
    expanded: [] as string[],
  })
  const showAll = () => state.showAll
  const expanded = () => state.expanded
  const overflow = createMemo(() => Math.max(0, edited() - MAX_FILES))
  const visible = createMemo(() => (showAll() ? diffs() : diffs().slice(0, MAX_FILES)))
  const toggleAll = () => {
    autoScroll.pause()
    setState("showAll", !showAll())
  }

  const assistantMessages = createMemo(
    () => {
      const msg = message()
      if (!msg) return emptyAssistant

      const messages = allMessages() ?? emptyMessages
      if (messageIndex() < 0) return emptyAssistant

      // Parent-linked assistant messages can outlive the old "stop at next user" boundary.
      return messages
        .slice(messageIndex() + 1)
        .filter((item): item is AssistantMessage => item.role === "assistant" && item.parentID === msg.id)
    },
    emptyAssistant,
    { equals: same },
  )

  const turnChange = createMemo(() => props.turnChanges?.[props.messageID])
  const turnInProgress = createMemo(() => {
    const messages = assistantMessages()
    if (!messages.length) return false
    return messages.some((item) => typeof item.time.completed !== "number")
  })
  const turnFiles = createMemo(() => turnChange()?.files ?? emptyTurnFiles)
  const turnEdited = createMemo(() => turnFiles().length)
  const turnAdditions = createMemo(() => turnFiles().reduce((sum, file) => sum + (file.additions ?? 0), 0))
  const turnDeletions = createMemo(() => turnFiles().reduce((sum, file) => sum + (file.deletions ?? 0), 0))
  const [turnExpanded, setTurnExpanded] = createSignal<string[]>([])
  const [confirmAction, setConfirmAction] = createSignal<"undo" | "redo" | undefined>()
  let confirmTimer: ReturnType<typeof setTimeout> | undefined
  const resetConfirm = () => {
    if (confirmTimer) clearTimeout(confirmTimer)
    confirmTimer = undefined
    setConfirmAction(undefined)
  }
  const primeConfirm = (action: "undo" | "redo") => {
    if (confirmAction() === action) return true
    setConfirmAction(action)
    if (confirmTimer) clearTimeout(confirmTimer)
    confirmTimer = setTimeout(resetConfirm, 3000)
    return false
  }
  onCleanup(resetConfirm)
  const mutateTurnChange = async () => {
    const current = turnChange()
    const id = current?.messageID
    if (!id) return
    const action = turnChangeAction(current)
    if (!action || !hasTurnChangeActionHandler(current, props.turnChangeActions)) return
    if (!primeConfirm(action)) return
    resetConfirm()
    if (action === "undo") await props.turnChangeActions?.undo?.(id)
    else await props.turnChangeActions?.redo?.(id)
  }
  const turnActionLabel = createMemo(() => {
    const current = turnChange()
    const action = turnChangeAction(current)
    if (!action) return ""
    const base =
      action === "undo" ? i18n.t("ui.sessionTurn.turnChanges.undo") : i18n.t("ui.sessionTurn.turnChanges.reapply")
    return confirmAction() === action
      ? action === "undo"
        ? i18n.t("ui.sessionTurn.turnChanges.undoConfirm")
        : i18n.t("ui.sessionTurn.turnChanges.redoConfirm")
      : base
  })
  const isUndoneTurn = createMemo(() => {
    const current = turnChange()
    return !!(current && current.redoAvailable && !current.undoAvailable)
  })
  const turnStatusLabel = (status: TurnChangeFile["status"]) => {
    if (status === "added") return i18n.t("ui.sessionTurn.turnChanges.status.added")
    if (status === "deleted") return i18n.t("ui.sessionTurn.turnChanges.status.deleted")
    return i18n.t("ui.sessionTurn.turnChanges.status.updated")
  }
  const interrupted = createMemo(() => assistantMessages().some((m) => m.error?.name === "MessageAbortedError"))
  const divider = createMemo(() => {
    if (compaction()) return i18n.t("ui.messagePart.compaction")
    if (interrupted()) return i18n.t("ui.message.interrupted")
    return ""
  })
  const error = createMemo(
    () => assistantMessages().find((m) => m.error && m.error.name !== "MessageAbortedError")?.error,
  )
  const showAssistantCopyPartID = createMemo(() => {
    const messages = assistantMessages()

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message) continue

      const parts = list(data.store.part?.[message.id], emptyParts)
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j]
        if (!part || part.type !== "text" || !part.text?.trim()) continue
        return part.id
      }
    }

    return undefined
  })
  const errorText = createMemo(() => {
    const msg = error()?.data?.message
    if (typeof msg === "string") return unwrap(msg)
    if (msg === undefined || msg === null) return ""
    // oxlint-disable-next-line no-base-to-string -- msg is unknown from error data, coercion is intentional
    return unwrap(String(msg))
  })

  const status = createMemo(() => {
    if (props.status !== undefined) return props.status
    if (typeof props.active === "boolean" && !props.active) return idle
    return data.store.session_status[props.sessionID] ?? idle
  })
  const working = createMemo(() => status().type !== "idle" && active())
  const showReasoningSummaries = createMemo(() => props.showReasoningSummaries ?? true)

  const assistantCopyPartID = createMemo(() => {
    if (working()) return null
    return showAssistantCopyPartID() ?? null
  })
  const turnDurationMs = createMemo(() => {
    const start = message()?.time.created
    if (typeof start !== "number") return undefined

    const end = assistantMessages().reduce<number | undefined>((max, item) => {
      const completed = item.time.completed
      if (typeof completed !== "number") return max
      if (max === undefined) return completed
      return Math.max(max, completed)
    }, undefined)

    if (typeof end !== "number") return undefined
    if (end < start) return undefined
    return end - start
  })
  const assistantDerived = createMemo(() => {
    let visible = 0
    let reason: string | undefined
    const show = showReasoningSummaries()
    for (const message of assistantMessages()) {
      for (const part of list(data.store.part?.[message.id], emptyParts)) {
        if (partState(part, show) === "visible") {
          visible++
        }
        if (part.type === "reasoning" && part.text) {
          const h = heading(part.text)
          if (h) reason = h
        }
      }
    }
    return { visible, reason }
  })
  const assistantVisible = createMemo(() => assistantDerived().visible)
  const reasoningHeading = createMemo(() => assistantDerived().reason)
  // "Thinking…" is a pre-first-visible-output liveness affordance only.
  // Slice 11b.1 third W1 retest (AstroHan msg=362e9b72 / GPT-X
  // msg=22179280): if any reasoning / prose / trow has surfaced, the
  // round already has its own liveness signal (TrowBlock shimmer,
  // streaming prose, working-time tick); a separate "thinking" row at
  // the bottom of the assistant-content block becomes a detached tail
  // duplicating that. Tighten the condition so the row only renders
  // before any visible part exists — the same `assistantVisible === 0`
  // gate the `showReasoningSummaries: true` path already used, applied
  // uniformly regardless of the setting (reasoning parts only count as
  // visible when summaries are on, so this preserves the "show
  // thinking while reasoning is streaming under the summary toggle"
  // behaviour). When the gate flips, the row is removed at the next
  // visible part, not faded out.
  const showThinking = createMemo(() => {
    if (!working() || !!error()) return false
    if (status().type === "retry") return false
    return assistantVisible() === 0
  })

  const autoScroll = createAutoScroll({
    working,
    onUserInteracted: props.onUserInteracted,
    overflowAnchor: "dynamic",
  })

  // W1 leaf bridges (Phase 2b). The bridge factory adapts the shell's
  // reactive graph to the context-free W1 leaves — `SessionTurnUserBubble`,
  // `SessionTurnAgentRound`, `TrowBlock` — by resolving the model
  // display name, the `partsByMessage` map for the agent-round's grouping
  // walk, the partID → owner-message lookup the trow `renderTool` slot
  // needs, the round's "latest" flag for the working-time tick, the
  // i18n label bundles, and the `actions.revert / actions.fork` adapters.
  // Lives in a sibling module so this shell stays at ≤500 lines per
  // AGENTS.md.
  const leaf = createSessionTurnLeafBridges({
    message,
    allMessages: () => allMessages() ?? emptyMessages,
    assistantMessages,
    assistantCopyPartID,
    turnDurationMs,
    working,
    actions: props.actions,
  })

  // Compaction divider stays — W1 doesn't redesign it. The interrupted
  // divider is dropped here because `<SessionTurnAgentRound>` renders
  // `<SystemEvent kind="interrupted">` inline at the round-end per
  // design doc §3.5.
  const compactionDivider = createMemo(() => (compaction() ? i18n.t("ui.messagePart.compaction") : ""))

  return (
    <div data-component="session-turn" class={props.classes?.root}>
      <div
        ref={autoScroll.scrollRef}
        onScroll={autoScroll.handleScroll}
        data-slot="session-turn-content"
        class={props.classes?.content}
      >
        <div onClick={autoScroll.handleInteraction}>
          <Show when={message()} keyed>
            {(message) => (
              <div
                ref={autoScroll.contentRef}
                data-message={message.id}
                data-slot="session-turn-message-container"
                class={props.classes?.container}
              >
                <div data-slot="session-turn-message-content" aria-live="off">
                  <SessionTurnUserBubble
                    message={message}
                    parts={parts()}
                    modelName={leaf.userModelName()}
                    locale={i18n.locale()}
                    labels={leaf.userBubbleLabels()}
                    actions={leaf.userBubbleActions()}
                  />
                </div>
                <Show when={compactionDivider()}>
                  <div data-slot="session-turn-compaction">
                    <MessageDivider label={compactionDivider()} />
                  </div>
                </Show>
                <Show when={assistantMessages().length > 0}>
                  <div data-slot="session-turn-assistant-content" aria-hidden={working()}>
                    <SessionTurnAgentRound
                      assistantMessages={assistantMessages()}
                      partsByMessage={leaf.partsByMessage()}
                      isLatestRound={leaf.isLatestRound()}
                      locale={i18n.locale()}
                      labels={leaf.agentRoundLabels()}
                      renderProse={leaf.renderProse}
                      renderTool={leaf.renderTool}
                      actions={leaf.agentRoundActions()}
                      showReasoningSummaries={showReasoningSummaries()}
                    />
                  </div>
                </Show>
                <Show when={showThinking()}>
                  <div data-slot="session-turn-thinking">
                    <TextShimmer text={i18n.t("ui.sessionTurn.status.thinking")} />
                    <Show when={!showReasoningSummaries()}>
                      <TextReveal
                        text={reasoningHeading()}
                        class="session-turn-thinking-heading"
                        travel={25}
                        duration={700}
                        truncate
                      />
                    </Show>
                  </div>
                </Show>
                <SessionRetry status={status()} show={active()} />
                <Show when={hasVisibleTurnChanges(turnChange()) && !working() && !turnInProgress()}>
                  <TurnChangesList
                    change={turnChange()!}
                    files={turnFiles()}
                    edited={turnEdited()}
                    additions={turnAdditions()}
                    deletions={turnDeletions()}
                    isUndone={isUndoneTurn()}
                    expanded={turnExpanded()}
                    setExpanded={setTurnExpanded}
                    actionLabel={turnActionLabel()}
                    confirmAction={confirmAction()}
                    hasAction={hasTurnChangeActionHandler(turnChange(), props.turnChangeActions)}
                    onAction={mutateTurnChange}
                    onResetConfirm={resetConfirm}
                    openFile={props.turnChangeActions?.openFile}
                    showInFolder={props.turnChangeActions?.showInFolder}
                    statusLabel={turnStatusLabel}
                  />
                </Show>
                <Show when={props.turnChanges === undefined && turnEdited() === 0 && edited() > 0 && !working()}>
                  <SessionTurnDiffsList
                    diffs={diffs()}
                    visible={visible()}
                    edited={edited()}
                    overflow={overflow()}
                    showAll={showAll()}
                    toggleAll={toggleAll}
                    expanded={expanded()}
                    onExpandedChange={(value) => setState("expanded", value)}
                  />
                </Show>
                <Show when={error()}>
                  <Card variant="error" class="error-card">
                    {errorText()}
                  </Card>
                </Show>
              </div>
            )}
          </Show>
          {props.children}
        </div>
      </div>
    </div>
  )
}
