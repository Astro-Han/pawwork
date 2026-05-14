import { createMemo, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { AssistantMessageDisplay } from "./assistant-message-display"
import { UserMessageDisplay } from "./user-message"
import { PART_MAPPING, type MessagePartProps, type MessageProps } from "./registry"

export function Message(props: MessageProps) {
  return (
    <>
      <Show when={props.message.role === "user"}>
        <UserMessageDisplay message={props.message as UserMessage} parts={props.parts} actions={props.actions} />
      </Show>
      <Show when={props.message.role === "assistant"}>
        <AssistantMessageDisplay
          message={props.message as AssistantMessage}
          parts={props.parts}
          showAssistantCopyPartID={props.showAssistantCopyPartID}
          showReasoningSummaries={props.showReasoningSummaries}
        />
      </Show>
    </>
  )
}

export function Part(props: MessagePartProps) {
  const component = createMemo(() => PART_MAPPING[props.part.type])
  return (
    <Show when={component()}>
      <Dynamic
        component={component()}
        part={props.part}
        message={props.message}
        hideDetails={props.hideDetails}
        defaultOpen={props.defaultOpen}
        showAssistantCopyPartID={props.showAssistantCopyPartID}
        turnDurationMs={props.turnDurationMs}
      />
    </Show>
  )
}
