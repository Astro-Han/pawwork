import {
  AssistantMessage,
  type SnapshotFileDiff,
  Message as MessageType,
  Part as PartType,
  UserMessage,
} from "@opencode-ai/sdk/v2/client"
import type { SessionStatus } from "@opencode-ai/sdk/v2"
import { useData } from "../context"
import { isWorkInFlightStatus } from "../util/session-status"

import { Binary } from "@opencode-ai/core/util/binary"
import { createEffect, createMemo, createSignal, onCleanup, ParentProps, Show } from "solid-js"
import { AssistantParts, Message, MessageDivider, PART_MAPPING, type UserActions } from "./message-part"
import { Card } from "./card"
import { Icon } from "./icon"
import { TextShimmer } from "./text-shimmer"
import { SessionRetry } from "./session-retry"
import { createAutoScroll } from "../hooks"
import { useI18n } from "../context/i18n"
import { hasVisibleTurnChanges, type TurnChangeActions, type TurnChangeDisplay } from "./session-turn-changes"
import { SessionTurnChangesPanel } from "./session-turn-changes-panel"
import { SessionTurnDiffs } from "./session-turn-diffs"
import { blurActiveElementInside } from "./session-turn-focus"
import {
  compactionDividerLabelKey,
  compactionDividerState,
  compactionElapsedSeconds,
  formatCompactionElapsed,
  type CompactionDividerState,
} from "./session-turn-compaction"
import { AssistantTurnFooter } from "./assistant-turn-footer"

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function unwrap(message: string) {
  const text = message.replace(/^Error:\s*/, "").trim()

  const parse = (value: string) => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }

  const read = (value: string) => {
    const first = parse(value)
    if (typeof first !== "string") return first
    return parse(first.trim())
  }

  let json = read(text)

  if (json === undefined) {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start !== -1 && end > start) {
      json = read(text.slice(start, end + 1))
    }
  }

  if (!record(json)) return message

  const err = record(json.error) ? json.error : undefined
  if (err) {
    const type = typeof err.type === "string" ? err.type : undefined
    const msg = typeof err.message === "string" ? err.message : undefined
    if (type && msg) return `${type}: ${msg}`
    if (msg) return msg
    if (type) return type
    const code = typeof err.code === "string" ? err.code : undefined
    if (code) return code
  }

  const msg = typeof json.message === "string" ? json.message : undefined
  if (msg) return msg

  const reason = typeof json.error === "string" ? json.error : undefined
  if (reason) return reason

  return message
}

function same<T>(a: readonly T[], b: readonly T[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function list<T>(value: T[] | undefined | null, fallback: T[]) {
  if (Array.isArray(value)) return value
  return fallback
}

const hidden = new Set(["todowrite"])

function partState(part: PartType) {
  if (part.type === "tool") {
    if (hidden.has(part.tool)) return
    if (part.tool === "question" && (part.state.status === "pending" || part.state.status === "running")) return
    return "visible" as const
  }
  if (part.type === "text") return part.text?.trim() ? ("visible" as const) : undefined
  // Reasoning always renders as a collapsible row
  if (part.type === "reasoning") return part.text?.trim() ? ("visible" as const) : undefined
  if (PART_MAPPING[part.type]) return "visible" as const
  return
}


export function SessionTurn(
  props: ParentProps<{
    sessionID: string
    messageID: string
    message?: UserMessage
    assistantMessages?: AssistantMessage[]
    messages?: MessageType[]
    actions?: UserActions
    turnChanges?: Record<string, TurnChangeDisplay | null | undefined>
    turnChangeActions?: TurnChangeActions
    active?: boolean
    status?: SessionStatus
    onUserInteracted?: () => void
    /**
     * Render slot for the rate-limit card (free_quota_exhausted classification).
     * App layer (RateLimitCardWiring in packages/app) supplies this so packages/ui
     * stays framework-agnostic. Forwarded to SessionRetry.
     */
    rateLimitCardSlot?: import("./session-retry").SessionRetryRateLimitSlot
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
    if (props.message?.id === props.messageID) return props.message
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

  // `rawAssistantMessages` keeps the compaction summary message visible to the
  // divider state machine. Every other derivation reads `visibleAssistantMessages`
  // so the summary never leaks into "Thinking…", error cards, copy targets,
  // turn-duration math, etc. — the compaction divider is its only carrier.
  const rawAssistantMessages = createMemo(
    () => {
      if (props.assistantMessages !== undefined) return props.assistantMessages
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

  const visibleAssistantMessages = createMemo(
    () => rawAssistantMessages().filter((m) => m.summary !== true),
    emptyAssistant,
    { equals: same },
  )

  const compactionSummary = createMemo(() => rawAssistantMessages().find((m) => m.summary === true))

  const turnChange = createMemo(() => props.turnChanges?.[props.messageID])
  const [turnExpanded, setTurnExpanded] = createSignal<string[]>([])
  const turnInProgress = createMemo(() => {
    const messages = visibleAssistantMessages()
    if (!messages.length) return false
    return messages.some((item) => typeof item.time.completed !== "number")
  })
  const status = createMemo(() => {
    if (props.status !== undefined) return props.status
    if (typeof props.active === "boolean" && !props.active) return idle
    return data.store.session_status[props.sessionID] ?? idle
  })
  const working = createMemo(() => isWorkInFlightStatus(status()) && active())
  const [assistantContent, setAssistantContent] = createSignal<HTMLElement>()
  const [assistantHidden, setAssistantHidden] = createSignal(false)
  createEffect(() => {
    const shouldHide = working()
    if (shouldHide) blurActiveElementInside(assistantContent())
    setAssistantHidden(shouldHide)
  })
  const compactionDivider = createMemo<CompactionDividerState | undefined>(() => {
    if (!compaction()) return undefined
    return compactionDividerState({ summaryAssistant: compactionSummary(), isWorking: working() })
  })
  const compactionLabel = createMemo(() => {
    const state = compactionDivider()
    if (!state) return undefined
    const summary = compactionSummary()
    const label = compactionDividerLabelKey({ state, error: summary?.error })
    if (label.key === "ui.messagePart.compaction.failed") {
      return i18n.t(label.key, label.params)
    }
    return i18n.t(label.key)
  })
  const divider = createMemo(() => {
    if (compactionDivider()) return compactionLabel() ?? ""
    return ""
  })
  const error = createMemo(
    () => visibleAssistantMessages().find((m) => m.error && m.error.name !== "MessageAbortedError")?.error,
  )
  const assistantFooterTarget = createMemo(() => {
    const messages = visibleAssistantMessages()

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message) continue

      const parts = list(data.store.part?.[message.id], emptyParts)
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j]
        if (!part || part.type !== "text" || !part.text?.trim()) continue
        return { message, text: part.text.trim() }
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

  const visibleTurnChange = createMemo(() => {
    const current = turnChange()
    if (!hasVisibleTurnChanges(current) || working() || turnInProgress()) return
    return current
  })
  const visibleFooterTarget = createMemo(() => {
    if (working()) return
    return assistantFooterTarget()
  })
  const turnDurationMs = createMemo(() => {
    const start = message()?.time.created
    if (typeof start !== "number") return undefined

    const end = visibleAssistantMessages().reduce<number | undefined>((max, item) => {
      const completed = item.time.completed
      if (typeof completed !== "number") return max
      if (max === undefined) return completed
      return Math.max(max, completed)
    }, undefined)

    if (typeof end !== "number") return undefined
    if (end < start) return undefined
    return end - start
  })
  const assistantVisible = createMemo(() => {
    let visible = 0
    for (const message of visibleAssistantMessages()) {
      for (const part of list(data.store.part?.[message.id], emptyParts)) {
        if (partState(part) === "visible") visible++
      }
    }
    return visible
  })
  // Once any provider-output part exists (text / reasoning / tool — the same set
  // the backend counts as `isProviderProgressEvent`), the provider has started
  // responding, so the silent wait is real "thinking". Before that — building
  // the request, connecting, waiting for the stream to be accepted, waiting for
  // the first chunk — it is only "connecting" (#1358). A `step-start` part does
  // not count: it can precede the first provider chunk and would otherwise make
  // a connection wait read as model reasoning.
  const providerStarted = createMemo(() => {
    for (const message of visibleAssistantMessages()) {
      for (const part of list(data.store.part?.[message.id], emptyParts)) {
        if (part.type === "text" || part.type === "reasoning" || part.type === "tool") return true
      }
    }
    return false
  })
  const showThinking = createMemo(() => {
    if (compactionDivider() === "pending") return false
    if (!working() || !!error()) return false
    if (status().type === "retry") return false
    return assistantVisible() === 0
  })

  const [compactionElapsedSec, setCompactionElapsedSec] = createSignal(0)
  createEffect(() => {
    const state = compactionDivider()
    const summary = compactionSummary()
    const userMsg = message()
    if (state !== "pending" || !userMsg) {
      setCompactionElapsedSec(0)
      return
    }
    setCompactionElapsedSec(
      compactionElapsedSeconds({
        state,
        summaryAssistant: summary,
        compactionUserMessage: userMsg,
        now: Date.now(),
      }),
    )
    const interval = setInterval(() => {
      setCompactionElapsedSec(
        compactionElapsedSeconds({
          state,
          summaryAssistant: summary,
          compactionUserMessage: userMsg,
          now: Date.now(),
        }),
      )
    }, 1000)
    onCleanup(() => clearInterval(interval))
  })
  const compactionElapsedLabel = createMemo(() => {
    if (compactionDivider() !== "pending") return undefined
    return formatCompactionElapsed(compactionElapsedSec())
  })

  // Compaction placeholders (user message whose only part is the compaction
  // marker) and re-injected continuation messages (auto-continue synthetic
  // text or replay-tagged user) keep their turn row so child assistants render
  // through `parentID`, but their user body is suppressed — the divider alone
  // represents the compaction event.
  const hideUserBody = createMemo(() => {
    const ps = parts()
    if (ps.length === 1 && ps[0]?.type === "compaction") return true
    const msg = message()
    if (!msg) return false
    if (msg.replay === true) return true
    if (ps.length === 0) return false
    return ps.every(
      (part) =>
        part.type === "text" &&
        part.synthetic === true &&
        (part.metadata as { compaction_continue?: unknown } | undefined)?.compaction_continue === true,
    )
  })

  const autoScroll = createAutoScroll({
    working,
    onUserInteracted: props.onUserInteracted,
    overflowAnchor: "dynamic",
  })

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
                <Show when={!hideUserBody()}>
                  <div data-slot="session-turn-message-content" aria-live="off">
                    <Message message={message} parts={parts()} actions={props.actions} />
                  </div>
                </Show>
                <Show when={divider()}>
                  <div data-slot="session-turn-compaction">
                    <MessageDivider
                      label={divider()}
                      state={compactionDivider()}
                      elapsed={compactionElapsedLabel()}
                    />
                  </div>
                </Show>
                <Show when={visibleAssistantMessages().length > 0}>
                  <div
                    ref={setAssistantContent}
                    data-slot="session-turn-assistant-content"
                    aria-hidden={assistantHidden()}
                    onFocusIn={() => {
                      if (assistantHidden()) blurActiveElementInside(assistantContent())
                    }}
                  >
                    <AssistantParts messages={visibleAssistantMessages()} working={working()} />
                  </div>
                </Show>
                <Show when={showThinking()}>
                  <div
                    data-slot="session-turn-thinking"
                    data-phase={providerStarted() ? "thinking" : "connecting"}
                  >
                    <TextShimmer
                      text={
                        providerStarted()
                          ? i18n.t("ui.sessionTurn.status.thinking")
                          : i18n.t("ui.sessionTurn.status.connecting")
                      }
                    />
                  </div>
                </Show>
                <SessionRetry status={status()} show={active()} rateLimitCardSlot={props.rateLimitCardSlot} />
                <Show when={visibleTurnChange()}>
                  {(display) => (
                    <SessionTurnChangesPanel
                      turnChange={display()}
                      actions={props.turnChangeActions}
                      expanded={turnExpanded()}
                      onExpandedChange={(value) => setTurnExpanded(value)}
                    />
                  )}
                </Show>
                <Show when={visibleFooterTarget()}>
                  {(target) => (
                    <AssistantTurnFooter
                      text={target().text}
                      message={target().message}
                      turnDurationMs={turnDurationMs()}
                    />
                  )}
                </Show>
                <Show when={!hasVisibleTurnChanges(turnChange()) && diffs().length > 0 && !working()}>
                  <SessionTurnDiffs
                    diffs={diffs()}
                    onShowAllToggle={() => autoScroll.pause()}
                    stateKey={props.messageID}
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
