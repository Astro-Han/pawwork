import { createMemo, Index, Match, Show, Switch } from "solid-js"
import type { AssistantMessage, Part as PartType, ReasoningPart, ToolPart } from "@opencode-ai/sdk/v2"
import { useI18n } from "../../context/i18n"
import { TrowBlock, type TrowPart } from "../session-turn-trow-block"
import { groupParts, partDefaultOpen, renderable, sameGroups, type PartGroup } from "./grouping"
import { contextToolSummaryText, contextTrowSummaryText } from "./context-tool-helpers"
import { index, latestDefined, same } from "./shared-utils"
import { Part } from "./message-router"

export function AssistantMessageDisplay(props: {
  message: AssistantMessage
  parts: PartType[]
}) {
  const i18n = useI18n()
  const emptyTrowParts: TrowPart[] = []
  const part = createMemo(() => index(props.parts))
  const grouped = createMemo(
    () =>
      groupParts(
        props.parts
          .filter((part) => renderable(part))
          .map((part) => ({
            messageID: props.message.id,
            part,
          })),
      ),
    [] as PartGroup[],
    { equals: sameGroups },
  )

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
                      .map((ref) => part().get(ref.partID))
                      .filter((p): p is TrowPart => !!p && (p.type === "tool" || p.type === "reasoning"))
                  },
                  emptyTrowParts,
                  { equals: same },
                )
                const toolParts = createMemo(() => parts().filter((p): p is ToolPart => p.type === "tool"))
                const singleTool = createMemo(() => toolParts().length === 1 && parts().length === 1)
                const defaultOpenForTool = (tool: ToolPart) => partDefaultOpen(tool) ?? singleTool()
                const renderReasoning = (reasoning: ReasoningPart) => (
                  <div data-slot="trow-result-body" data-timeline-anchor={`reasoning:${reasoning.id}`}>
                    <Part
                      part={reasoning}
                      message={props.message}
                      defaultOpen={false}
                      stateKey={`reasoning:${reasoning.id}`}
                    />
                  </div>
                )

                return (
                  <Show when={parts().length > 0}>
                    <TrowBlock
                      parts={parts()}
                      labels={{
                        summaryRunning: (count) => i18n.t("ui.sessionTurn.trow.summary.running", { count }),
                        summaryCompleted: (parts, failed) => contextTrowSummaryText(parts, failed, i18n),
                        thinking: i18n.t("ui.sessionTurn.status.thinking"),
                      }}
                      describeTool={(tool) => contextToolSummaryText(tool, i18n)}
                      renderTool={(tool) => (
                        <div data-slot="trow-result-body" data-timeline-anchor={`tool:${tool.id}`}>
                          <Part
                            part={tool}
                            message={props.message}
                            defaultOpen={defaultOpenForTool(tool)}
                            stateKey={`tool:${tool.id}`}
                          />
                        </div>
                      )}
                      renderReasoning={renderReasoning}
                    />
                  </Show>
                )
              })()}
            </Match>
            <Match when={entryType() === "part"}>
              {(() => {
                const item = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return
                  return part().get(entry.ref.partID)
                })
                const stableItem = latestDefined(() => item())

                return (
                  <Show when={stableItem()}>
                    <Part
                      part={stableItem()!}
                      message={props.message}
                      stateKey={`tool:${stableItem()!.id}`}
                    />
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
