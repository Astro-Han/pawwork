import { Show } from "solid-js"
import { useI18n } from "../../../context/i18n"
import { Icon } from "../../icon"
import { TextShimmer } from "../../text-shimmer"
import type { CompactionDividerState } from "../../session-turn-compaction"
import { registerPartComponent } from "../registry"

export function MessageDivider(props: {
  label: string
  state?: CompactionDividerState
  elapsed?: string
}) {
  const state = () => props.state
  const isPending = () => state() === "pending"
  const isAborted = () => state() === "aborted"
  const isFailed = () => state() === "failed"
  return (
    <div data-component="compaction-part" data-state={state() ?? "static"}>
      <div data-slot="compaction-part-divider">
        <span data-slot="compaction-part-line" />
        <span data-slot="compaction-part-label" class="text-body">
          <Show when={isAborted()}>
            <Icon name="circle-ban-sign" data-slot="compaction-part-icon" />
          </Show>
          <Show when={isFailed()}>
            <Icon name="circle-x" data-slot="compaction-part-icon" />
          </Show>
          <Show
            when={isPending()}
            fallback={<span data-slot="compaction-part-text">{props.label}</span>}
          >
            <TextShimmer text={props.label} active={true} />
            <Show when={props.elapsed}>
              <span data-slot="compaction-part-elapsed">{props.elapsed}</span>
            </Show>
          </Show>
        </span>
        <span data-slot="compaction-part-line" />
      </div>
    </div>
  )
}

registerPartComponent("compaction", function CompactionPartDisplay() {
  const i18n = useI18n()
  return <MessageDivider label={i18n.t("ui.messagePart.compaction")} />
})
