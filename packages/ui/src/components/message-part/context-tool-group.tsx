import { createMemo, createSignal, For, Index, Show } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { useI18n } from "../../context/i18n"
import { Collapsible } from "../collapsible"
import { TextShimmer } from "../text-shimmer"
import { AnimatedCountList } from "../tool-count-summary"
import { ToolStatusTitle } from "../tool-status-title"
import { contextToolSummary, contextToolTrigger } from "./context-tool-helpers"

const contextToolGroupOpenState = new Map<string, boolean>()

export function ContextToolGroup(props: { parts: ToolPart[]; busy?: boolean }) {
  const i18n = useI18n()
  const stateKey = createMemo(() => props.parts.map((part) => part.id).join(":"))
  const [open, setOpen] = createSignal(contextToolGroupOpenState.get(stateKey()) ?? false)
  const setPersistentOpen = (value: boolean) => {
    setOpen(value)
    contextToolGroupOpenState.set(stateKey(), value)
  }
  const pending = createMemo(
    () =>
      !!props.busy || props.parts.some((part) => part.state.status === "pending" || part.state.status === "running"),
  )
  const summary = createMemo(() => contextToolSummary(props.parts))

  return (
    <Collapsible open={open()} onOpenChange={setPersistentOpen} variant="ghost" class="tool-collapsible">
      <Collapsible.Trigger>
        <div data-component="context-tool-group-trigger">
          <span data-slot="context-tool-group-title" class="min-w-0 flex items-center gap-2 text-h3 text-fg-strong">
            <span data-slot="context-tool-group-label" class="shrink-0">
              <ToolStatusTitle
                active={pending()}
                activeText={i18n.t("ui.sessionTurn.status.gatheringContext")}
                doneText={i18n.t("ui.sessionTurn.status.gatheredContext")}
                split={false}
              />
            </span>
            <span
              data-slot="context-tool-group-summary"
              class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-fg-base"
            >
              <AnimatedCountList
                items={[
                  {
                    key: "read",
                    count: summary().read,
                    one: i18n.t("ui.messagePart.context.read.one"),
                    other: i18n.t("ui.messagePart.context.read.other"),
                  },
                  {
                    key: "search",
                    count: summary().search,
                    one: i18n.t("ui.messagePart.context.search.one"),
                    other: i18n.t("ui.messagePart.context.search.other"),
                  },
                  {
                    key: "list",
                    count: summary().list,
                    one: i18n.t("ui.messagePart.context.list.one"),
                    other: i18n.t("ui.messagePart.context.list.other"),
                  },
                ]}
                fallback=""
              />
            </span>
          </span>
          <Collapsible.Arrow />
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div data-component="context-tool-group-list">
          <Index each={props.parts}>
            {(partAccessor) => {
              const trigger = createMemo(() => contextToolTrigger(partAccessor(), i18n))
              const running = createMemo(
                () => partAccessor().state.status === "pending" || partAccessor().state.status === "running",
              )
              return (
                <div data-slot="context-tool-group-item">
                  <div data-component="tool-trigger">
                    <div data-slot="basic-tool-tool-trigger-content">
                      <div data-slot="basic-tool-tool-info">
                        <div data-slot="basic-tool-tool-info-structured">
                          <div data-slot="basic-tool-tool-info-main">
                            <span data-slot="basic-tool-tool-title">
                              <TextShimmer text={trigger().title} active={running()} />
                            </span>
                            <Show when={!running() && trigger().subtitle}>
                              <span data-slot="basic-tool-tool-subtitle">{trigger().subtitle}</span>
                            </Show>
                            <Show when={!running() && trigger().args?.length}>
                              <For each={trigger().args}>
                                {(arg) => <span data-slot="basic-tool-tool-arg">{arg}</span>}
                              </For>
                            </Show>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )
            }}
          </Index>
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}
