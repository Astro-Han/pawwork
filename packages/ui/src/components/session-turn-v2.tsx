import { createMemo, type JSX } from "solid-js"
import { Show } from "solid-js"
import { Binary } from "@opencode-ai/core/util/binary"
import {
  AssistantMessage,
  Message as MessageType,
  Part as PartType,
  UserMessage,
} from "@opencode-ai/sdk/v2/client"
import type { SessionStatus } from "@opencode-ai/sdk/v2"
import { useData } from "../context"
import { useI18n } from "../context/i18n"
import { Markdown } from "./markdown"
import { SessionTurnAgentRound } from "./session-turn-agent-round"
import { SessionTurnUserBubble } from "./session-turn-user-bubble"
import type { TrowBlockLabels } from "./session-turn-trow-block"
import type { UserActions } from "./message-part"
import "./session-turn-v2.css"

/**
 * Slice 11b.1 hybrid opt-in shell that wires the new leaf components
 * (user-bubble + agent-round + trow-block + system-event) together
 * against the existing `useData` / `useI18n` data layer.
 *
 * **This is opt-in, not the default user-path.** Slice 11b.1's PR #589
 * intentionally keeps the existing `SessionTurn` mounted as the default
 * route; consumers wanting the new visual surface import this file
 * directly (`@opencode-ai/ui/session-turn-v2`). The sibling slice that
 * lands after Phase 3a will switch the default and remove the legacy
 * `SessionTurn` in one line.
 *
 * Coverage in this v2 dispatcher:
 *  - User bubble (cream, attachments above, hover toolbar Copy / Reset)
 *  - Agent round (working-time tick, prose + reasoning + trow-block via
 *    `groupParts`, hover toolbar Copy / Fork, full-suppression while
 *    running, interrupt system event)
 *
 * Deferred to sibling slice (legacy `SessionTurn` still owns these):
 *  - `turnChanges` undo / redo UI
 *  - `diffs` accordion
 *  - `SessionRetry` overlay
 *  - error card (non-abort errors)
 *  - `MessageDivider` compaction label
 *  - `JumpToBottom` wiring (the leaf component is shipped; the
 *    SessionTurn shell does not own the scroll container in 11b.1)
 *
 * The component is intentionally a thin dispatcher: it pre-resolves
 * i18n labels and parts-by-message maps so the leaf components remain
 * context-free and unit-testable.
 */

export interface SessionTurnV2Props {
  sessionID: string
  messageID: string
  messages?: MessageType[]
  actions?: UserActions
  showReasoningSummaries?: boolean
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
  active?: boolean
  status?: SessionStatus
  /** Resolved display name for the model the user picked for this round. */
  modelName?: string
  classes?: {
    root?: string
  }
}

function list<T>(value: T[] | undefined | null, fallback: T[]) {
  if (Array.isArray(value)) return value
  return fallback
}

function same<T>(a: readonly T[], b: readonly T[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

export function SessionTurnV2(props: SessionTurnV2Props): JSX.Element {
  const data = useData()
  const i18n = useI18n()

  const emptyMessages: MessageType[] = []
  const emptyParts: PartType[] = []
  const emptyAssistant: AssistantMessage[] = []

  const allMessages = createMemo(
    () => props.messages ?? list(data.store.message?.[props.sessionID], emptyMessages),
  )

  const messageIndex = createMemo(() => {
    const messages = allMessages() ?? emptyMessages
    const result = Binary.search(messages, props.messageID, (m) => m.id)
    const index = result.found ? result.index : messages.findIndex((m) => m.id === props.messageID)
    if (index < 0) return -1
    const msg = messages[index]
    if (!msg || msg.role !== "user") return -1
    return index
  })

  const userMessage = createMemo<UserMessage | undefined>(() => {
    const index = messageIndex()
    if (index < 0) return undefined
    const messages = allMessages() ?? emptyMessages
    const msg = messages[index]
    if (!msg || msg.role !== "user") return undefined
    return msg
  })

  const userParts = createMemo(() => {
    const msg = userMessage()
    if (!msg) return emptyParts
    return list(data.store.part?.[msg.id], emptyParts)
  })

  const assistantMessages = createMemo(
    () => {
      const msg = userMessage()
      if (!msg) return emptyAssistant
      const messages = allMessages() ?? emptyMessages
      if (messageIndex() < 0) return emptyAssistant
      return messages
        .slice(messageIndex() + 1)
        .filter(
          (item): item is AssistantMessage => item.role === "assistant" && item.parentID === msg.id,
        )
    },
    emptyAssistant,
    { equals: same },
  )

  const partsByMessage = createMemo<Record<string, readonly PartType[]>>(() => {
    const out: Record<string, readonly PartType[]> = {}
    for (const message of assistantMessages()) {
      out[message.id] = list(data.store.part?.[message.id], emptyParts)
    }
    return out
  })

  // Whether this round is the latest in the session — only the latest
  // round may keep its working-time tick ticking. (Matches the
  // SessionTurnAgentRound prop contract.)
  const isLatestRound = createMemo(() => {
    const messages = allMessages() ?? emptyMessages
    if (!messages.length) return false
    // Find the last user message in the session; if it matches our round
    // origin, we are the latest round.
    let lastUserID: string | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const item = messages[i]
      if (item?.role === "user") {
        lastUserID = item.id
        break
      }
    }
    return lastUserID === props.messageID
  })

  // ---------------------------------------------------------------------------
  // Label maps — pre-resolved so the leaf components stay context-free.
  // ---------------------------------------------------------------------------

  const trowLabels = createMemo<TrowBlockLabels>(() => ({
    summaryRunning: (count) => i18n.t("ui.sessionTurnV2.trow.running", { count }),
    summaryCompleted: (count) => i18n.t("ui.sessionTurnV2.trow.completed", { count }),
    summaryWithFailed: (count, failed) =>
      i18n.t("ui.sessionTurnV2.trow.withFailed", { count, failed }),
  }))

  const userBubbleLabels = createMemo(() => ({
    copy: i18n.t("ui.message.copy"),
    copied: i18n.t("ui.message.copied"),
    reset: i18n.t("ui.message.revertMessage"),
  }))

  const agentLabels = createMemo(() => ({
    copy: i18n.t("ui.message.copyResponse"),
    copied: i18n.t("ui.message.copied"),
    fork: i18n.t("ui.message.forkMessage"),
    interrupted: i18n.t("ui.message.interrupted"),
    workingTime: (seconds: number) => i18n.t("ui.sessionTurnV2.workingTime", { seconds }),
    trow: trowLabels(),
  }))

  // ---------------------------------------------------------------------------
  // Action plumbing — translate the existing SessionAction shape into the
  // 0-arg async handlers the leaf components expect. When the host doesn't
  // pass a handler, the leaf hides the corresponding button via its own
  // `Show when={props.actions?.onX}` gate.
  // ---------------------------------------------------------------------------

  const userActions = createMemo(() => ({
    onReset: props.actions?.revert
      ? async () => {
          await props.actions?.revert?.({
            sessionID: props.sessionID,
            messageID: props.messageID,
          })
        }
      : undefined,
  }))

  const agentActions = createMemo(() => ({
    onFork: props.actions?.fork
      ? async () => {
          await props.actions?.fork?.({
            sessionID: props.sessionID,
            messageID: props.messageID,
          })
        }
      : undefined,
  }))

  // The shell delegates streaming-paced markdown to the existing
  // `<Markdown>` component. The leaf's `renderProse` slot lets us inject
  // it without coupling the leaf's import graph to the markdown stack.
  const renderProse = (input: { messageID: string; partID: string; text: string }): JSX.Element => (
    <Markdown text={input.text} cacheKey={input.partID} streaming={isLatestRound()} />
  )

  return (
    <div data-component="session-turn-v2" class={props.classes?.root}>
      <Show when={userMessage()} keyed>
        {(message) => (
          <SessionTurnUserBubble
            message={message}
            parts={userParts()}
            modelName={props.modelName}
            labels={userBubbleLabels()}
            actions={userActions()}
          />
        )}
      </Show>
      <Show when={assistantMessages().length > 0}>
        <SessionTurnAgentRound
          assistantMessages={assistantMessages()}
          partsByMessage={partsByMessage()}
          isLatestRound={isLatestRound()}
          labels={agentLabels()}
          actions={agentActions()}
          renderProse={renderProse}
          shellToolDefaultOpen={props.shellToolDefaultOpen}
          editToolDefaultOpen={props.editToolDefaultOpen}
        />
      </Show>
    </div>
  )
}
