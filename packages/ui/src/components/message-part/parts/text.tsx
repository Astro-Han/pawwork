import { createMemo, Show } from "solid-js"
import type { AssistantMessage, TextPart } from "@opencode-ai/sdk/v2"
import { MessageMarkdown, PacedMarkdown } from "../markdown-render"
import { registerPartComponent } from "../registry"

registerPartComponent("text", function TextPartDisplay(props) {
  const part = () => props.part as TextPart
  const streaming = createMemo(
    () => props.message.role === "assistant" && typeof (props.message as AssistantMessage).time.completed !== "number",
  )
  const text = () => (part().text ?? "").trim()

  return (
    <Show when={text()}>
      <div data-component="text-part">
        <div data-slot="text-part-body">
          <Show when={streaming()} fallback={<MessageMarkdown text={text()} cacheKey={part().id} streaming={false} />}>
            <PacedMarkdown text={text()} cacheKey={part().id} streaming={streaming()} />
          </Show>
        </div>
      </div>
    </Show>
  )
})
