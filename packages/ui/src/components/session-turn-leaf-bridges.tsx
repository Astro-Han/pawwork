import { createMemo, type Accessor } from "solid-js"
import type {
  AssistantMessage,
  Message as MessageType,
  Part as PartType,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2/client"
import { useData } from "../context"
import { useI18n } from "../context/i18n"
import { Part } from "./message-part-registry"
import { PacedMarkdown } from "./message-part-markdown"
import type { SessionTurnAgentRoundProps } from "./session-turn-agent-round"
import type { UserActions } from "./message-part-types"
import { list } from "./session-turn-helpers"

/**
 * Slice 11b.1 Phase 2b: W1 leaf bridge factory.
 *
 * The session-turn shell owns the full reactive graph (memos, signals,
 * autoscroll, retry, error, etc.). Adapting that graph to the
 * context-free W1 leaf components — `SessionTurnUserBubble`,
 * `SessionTurnAgentRound`, `TrowBlock` — needs ~150 lines of pure
 * bridge code: model-name resolution, partsByMessage map, partID →
 * owner-message lookup, isLatestRound derivation, i18n label bundles,
 * action wrappers, and the `renderProse` / `renderTool` slots.
 *
 * Living in a sibling module keeps `session-turn.tsx` at ≤500 lines per
 * AGENTS.md and turns the leaf-wiring logic into a single import the
 * shell can reuse. The factory takes accessors so it stays inside the
 * shell's reactive scope without leaking signals across files.
 */

export type LeafBridgeInputs = {
  message: Accessor<UserMessage | undefined>
  allMessages: Accessor<readonly MessageType[]>
  assistantMessages: Accessor<readonly AssistantMessage[]>
  assistantCopyPartID: Accessor<string | null>
  turnDurationMs: Accessor<number | undefined>
  working: Accessor<boolean>
  actions?: UserActions
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
}

export function createSessionTurnLeafBridges(input: LeafBridgeInputs) {
  const data = useData()
  const i18n = useI18n()
  const emptyParts: PartType[] = []

  const userModelName = createMemo(() => {
    const msg = input.message()
    const providerID = msg?.model?.providerID
    const modelID = msg?.model?.modelID
    if (!providerID || !modelID) return undefined
    const match = data.store.provider?.all?.find((p) => p.id === providerID)
    return match?.models?.[modelID]?.name ?? modelID
  })

  // partsByMessage: agent-round needs SDK parts keyed by assistant
  // message id so its internal `groupParts()` walk can flatten the
  // round in order.
  const partsByMessage = createMemo(() => {
    const out: Record<string, readonly PartType[]> = {}
    for (const msg of input.assistantMessages()) {
      out[msg.id] = list(data.store.part?.[msg.id], emptyParts)
    }
    return out
  })

  // partOwnerMap: ToolPart → owning AssistantMessage so the trow
  // renderTool slot can dispatch through `<Part>` with the right
  // message context.
  const partOwnerMap = createMemo(() => {
    const out = new Map<string, AssistantMessage>()
    for (const msg of input.assistantMessages()) {
      for (const part of list(data.store.part?.[msg.id], emptyParts)) {
        out.set(part.id, msg)
      }
    }
    return out
  })

  // isLatestRound: only the last user message in the session is allowed
  // to keep ticking the working-time counter. Older rounds whose
  // `time.completed` is missing freeze at their last observed elapsed
  // value (design doc §3.2).
  const isLatestRound = createMemo(() => {
    const messages = input.allMessages()
    const msg = input.message()
    if (!msg) return false
    for (let i = messages.length - 1; i >= 0; i--) {
      const item = messages[i]
      if (!item || item.role !== "user") continue
      return item.id === msg.id
    }
    return false
  })

  // i18n-resolved label bundle. The leaves are context-free — they
  // accept pre-resolved strings + a single `workingTime(seconds)` /
  // `summary*(count)` function family for live values. All copy /
  // aria-label / interrupted strings flow through here so future i18n
  // revisions stay in one place.
  const userBubbleLabels = createMemo(() => ({
    copy: i18n.t("ui.message.copyMessage"),
    copied: i18n.t("ui.message.copied"),
    reset: i18n.t("ui.message.revertMessage"),
  }))

  const agentRoundLabels = createMemo<SessionTurnAgentRoundProps["labels"]>(() => ({
    copy: i18n.t("ui.message.copyResponse"),
    copied: i18n.t("ui.message.copied"),
    fork: i18n.t("ui.sessionTurn.bubble.fork"),
    interrupted: i18n.t("ui.message.interrupted"),
    workingTime: (seconds) => i18n.t("ui.sessionTurn.workingTime", { seconds }),
    trow: {
      summaryRunning: (count) => i18n.t("ui.sessionTurn.trow.summary.running", { count }),
      summaryCompleted: (count) => i18n.t("ui.sessionTurn.trow.summary.completed", { count }),
      summaryWithFailed: (count, failed) =>
        i18n.t("ui.sessionTurn.trow.summary.withFailed", { count, failed }),
    },
  }))

  // Bridge `actions.revert` / `actions.fork` (host SessionAction shape:
  // `(input: { sessionID, messageID }) => Promise<void>`) into the
  // zero-argument callbacks the W1 leaves expose.
  const userBubbleActions = createMemo(() => {
    const revert = input.actions?.revert
    const msg = input.message()
    if (!revert || !msg) return undefined
    return {
      onReset: () => Promise.resolve(revert({ sessionID: msg.sessionID, messageID: msg.id })),
    }
  })

  const agentRoundActions = createMemo(() => {
    const fork = input.actions?.fork
    const msg = input.message()
    if (!fork || !msg) return undefined
    return {
      onFork: () => Promise.resolve(fork({ sessionID: msg.sessionID, messageID: msg.id })),
    }
  })

  // Caller-injected slots.
  const renderProse: SessionTurnAgentRoundProps["renderProse"] = (slot) => (
    <PacedMarkdown text={slot.text} cacheKey={slot.partID} streaming={input.working()} />
  )

  // `trow-result-body` is the single scoping boundary for DESIGN.md L417
  // per-tool body chrome (transparent + 1px --border-weaker + radius-sm
  // + mono-small / fg-weak). AstroHan flagged in the second W1 retest
  // that read / find / web search / bash still rendered their legacy
  // sans / base / large title block inside the trow body. Rewriting
  // every renderer would touch the whole tool registry — and the next
  // tool added would re-introduce the same drift. Instead the boundary
  // lives at the trow result body wrapper, and the scoped CSS reset in
  // `session-turn-trow-block.css` flattens any inner Part chrome's
  // hard-coded typography to the W1 caption family. New tools inherit
  // the reset automatically without touching the registry.
  const renderTool = (part: ToolPart) => {
    const owner = partOwnerMap().get(part.id)
    if (!owner) return null
    return (
      <div data-slot="trow-result-body">
        <Part
          part={part}
          message={owner}
          showAssistantCopyPartID={input.assistantCopyPartID()}
          turnDurationMs={input.turnDurationMs()}
          defaultOpen={part.tool === "bash" ? input.shellToolDefaultOpen : input.editToolDefaultOpen}
        />
      </div>
    )
  }

  return {
    userModelName,
    partsByMessage,
    isLatestRound,
    userBubbleLabels,
    agentRoundLabels,
    userBubbleActions,
    agentRoundActions,
    renderProse,
    renderTool,
  }
}
