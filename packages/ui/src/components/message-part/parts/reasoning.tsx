import { createMemo } from "solid-js"
import type { AssistantMessage, ReasoningPart } from "@opencode-ai/sdk/v2"
import { BasicTool } from "../../basic-tool"
import { useI18n } from "../../../context/i18n"
import { MessageMarkdown, PacedMarkdown } from "../markdown-render"
import { registerPartComponent } from "../registry"

// Reasoning reuses the same BasicTool shell as tool calls so it folds into
// the trow block as a peer row — one leading icon (supplied by the trow
// summary), a "思考中" trigger, and the thinking text in the collapsible
// body. No bespoke reasoning collapsible, no second icon.
registerPartComponent("reasoning", function ReasoningPartDisplay(props) {
  const i18n = useI18n()
  const part = () => props.part as ReasoningPart
  // Streaming while the assistant message has no completed timestamp
  const streaming = createMemo(
    () => props.message.role === "assistant" && typeof (props.message as AssistantMessage).time.completed !== "number",
  )
  const text = () => part().text.trim()

  return (
    <BasicTool
      icon="thinking"
      status={streaming() ? "running" : "completed"}
      defaultOpen={props.defaultOpen}
      stateKey={props.stateKey}
      trigger={{ title: i18n.t("ui.sessionTurn.status.thinking") }}
    >
      <div data-component="reasoning-body">
        {streaming() ? (
          <PacedMarkdown text={text()} cacheKey={part().id} streaming={streaming()} />
        ) : (
          <MessageMarkdown text={text()} cacheKey={part().id} streaming={false} />
        )}
      </div>
    </BasicTool>
  )
})
