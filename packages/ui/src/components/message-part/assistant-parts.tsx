import { createMemo, Index, Match, Show, Switch } from "solid-js"
import type { AssistantMessage, Part as PartType, ToolPart } from "@opencode-ai/sdk/v2"
import { useData } from "../../context"
import { ContextToolGroup } from "./context-tool-group"
import { groupParts, isContextGroupTool, partDefaultOpen, renderable, sameGroups, type PartGroup } from "./grouping"
import { index, latestDefined, list, same } from "./shared-utils"
import { Part } from "./message-router"

export function AssistantParts(props: {
  messages: AssistantMessage[]
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  working?: boolean
  showReasoningSummaries?: boolean
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
}) {
  const data = useData()
  const emptyParts: PartType[] = []
  const emptyTools: ToolPart[] = []
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
            .filter((part) => renderable(part, props.showReasoningSummaries ?? true))
            .map((part) => ({
              messageID: message.id,
              part,
            })),
        ),
      ),
    [] as PartGroup[],
    { equals: sameGroups },
  )

  const last = createMemo(() => grouped().at(-1)?.key)

  return (
    <Index each={grouped()}>
      {(entryAccessor) => {
        const entryType = createMemo(() => entryAccessor().type)

        return (
          <Switch>
            <Match when={entryType() === "context"}>
              {(() => {
                const parts = createMemo(
                  () => {
                    const entry = entryAccessor()
                    if (entry.type !== "context") return emptyTools
                    return entry.refs
                      .map((ref) => part().get(ref.messageID)?.get(ref.partID))
                      .filter((part): part is ToolPart => !!part && isContextGroupTool(part))
                  },
                  emptyTools,
                  { equals: same },
                )
                const busy = createMemo(() => props.working && last() === entryAccessor().key)

                return (
                  <Show when={parts().length > 0}>
                    <ContextToolGroup parts={parts()} busy={busy()} />
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
                        showAssistantCopyPartID={props.showAssistantCopyPartID}
                        turnDurationMs={props.turnDurationMs}
                        defaultOpen={partDefaultOpen(
                          stableItem()!,
                          props.shellToolDefaultOpen,
                          props.editToolDefaultOpen,
                        )}
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
