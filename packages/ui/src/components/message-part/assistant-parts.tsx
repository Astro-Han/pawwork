import { createMemo, Index, Match, Show, Switch } from "solid-js"
import type { AssistantMessage, Part as PartType, ReasoningPart, ToolPart } from "@opencode-ai/sdk/v2"
import { useData } from "../../context"
import { useI18n } from "../../context/i18n"
import { TrowBlock, type TrowPart } from "../session-turn-trow-block"
import { activeWorkingTrowKey, groupParts, partDefaultOpen, renderable, sameGroups, type PartGroup } from "./grouping"
import { contextToolSummaryText, contextTrowSummaryText } from "./context-tool-helpers"
import { index, latestDefined, list, same } from "./shared-utils"
import { Part } from "./message-router"

export function AssistantParts(props: {
  messages: AssistantMessage[]
  working?: boolean
}) {
  const data = useData()
  const i18n = useI18n()
  const emptyParts: PartType[] = []
  const emptyTools: ToolPart[] = []
  const emptyTrowParts: TrowPart[] = []
  const msgs = createMemo(() => index(props.messages))
  const part = createMemo(
    () =>
      new Map(
        props.messages.map((message) => [message.id, index(list(data.store.part?.[message.id], emptyParts))] as const),
      ),
  )

  const grouped = createMemo(
    () =>
      groupParts(
        props.messages.flatMap((message) =>
          list(data.store.part?.[message.id], emptyParts)
            .filter((part) => renderable(part))
            .map((part) => ({
              messageID: message.id,
              part,
            })),
        ),
      ),
    [] as PartGroup[],
    { equals: sameGroups },
  )
  const workingTrowKey = createMemo(() => activeWorkingTrowKey(grouped(), props.working))

  return (
    <Index each={grouped()}>
      {(entryAccessor) => {
        const entryType = createMemo(() => entryAccessor().type)

        return (
          <Switch>
            <Match when={entryType() === "trow"}>
              {(() => {
                const parts = createMemo(
                  () => {
                    const entry = entryAccessor()
                    if (entry.type !== "trow") return emptyTrowParts
                    return entry.refs
                      .map((ref) => part().get(ref.messageID)?.get(ref.partID))
                      .filter((p): p is TrowPart => !!p && (p.type === "tool" || p.type === "reasoning"))
                  },
                  emptyTrowParts,
                  { equals: same },
                )
                const toolParts = createMemo(() => parts().filter((p): p is ToolPart => p.type === "tool"))
                const singleTool = createMemo(() => toolParts().length === 1 && parts().length === 1)
                const defaultOpenForTool = (tool: ToolPart) => partDefaultOpen(tool) ?? singleTool()
                const renderTool = (tool: ToolPart) => {
                  const message = msgs().get(tool.messageID)
                  if (!message) return null
                  return (
                    <div data-slot="trow-result-body" data-timeline-anchor={`tool:${tool.id}`}>
                      <Part
                        part={tool}
                        message={message}
                        defaultOpen={defaultOpenForTool(tool)}
                        stateKey={`tool:${tool.id}`}
                      />
                    </div>
                  )
                }
                const renderReasoning = (reasoning: ReasoningPart) => {
                  const message = msgs().get(reasoning.messageID)
                  if (!message) return null
                  return (
                    <div data-slot="trow-result-body" data-timeline-anchor={`reasoning:${reasoning.id}`}>
                      <Part
                        part={reasoning}
                        message={message}
                        defaultOpen={false}
                        stateKey={`reasoning:${reasoning.id}`}
                      />
                    </div>
                  )
                }

                return (
                  <Show when={parts().length > 0}>
                    <TrowBlock
                      parts={parts()}
                      working={entryAccessor().key === workingTrowKey()}
                      labels={{
                        summaryRunning: (count) => i18n.t("ui.sessionTurn.trow.summary.running", { count }),
                        summaryCompleted: (parts, failed) => contextTrowSummaryText(parts, failed, i18n),
                        thinking: i18n.t("ui.sessionTurn.status.thinking"),
                      }}
                      describeTool={(tool) => contextToolSummaryText(tool, i18n)}
                      renderTool={renderTool}
                      renderReasoning={renderReasoning}
                    />
                  </Show>
                )
              })()}
            </Match>
            <Match when={entryType() === "part"}>
              {(() => {
                const message = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return
                  return msgs().get(entry.ref.messageID)
                })
                const item = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return
                  return part().get(entry.ref.messageID)?.get(entry.ref.partID)
                })
                const stableMessage = latestDefined(() => message())
                const stableItem = latestDefined(() => item())

                return (
                  <Show when={stableMessage()}>
                    <Show when={stableItem()}>
                      <Part
                        part={stableItem()!}
                        message={stableMessage()!}
                        defaultOpen={partDefaultOpen(stableItem()!)}
                        stateKey={`tool:${stableItem()!.id}`}
                      />
                    </Show>
                  </Show>
                )
              })()}
            </Match>
          </Switch>
        )
      }}
    </Index>
  )
}
