import { createMemo, Match, Show, Switch } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useLocation } from "@solidjs/router"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { useData } from "../../../context"
import { useI18n } from "../../../context/i18n"
import { GenericTool } from "../../basic-tool"
import { ToolErrorCard } from "../../tool-error-card"
import { webSearchErrorDisplay } from "../../websearch-error-copy"
import { sessionLink } from "../session-link"
import { registerPartComponent, ToolRegistry } from "../registry"
import { toolStateError, toolStateMetadata } from "../context-tool-helpers"

registerPartComponent("tool", function ToolPartDisplay(props) {
  const data = useData()
  const i18n = useI18n()
  const part = () => props.part as ToolPart
  if (part().tool === "todowrite") return null

  const hideQuestion = createMemo(
    () => part().tool === "question" && (part().state.status === "pending" || part().state.status === "running"),
  )

  const emptyInput: Record<string, any> = {}
  const emptyMetadata: Record<string, any> = {}

  const input = () => part().state?.input ?? emptyInput
  const partMetadata = () => toolStateMetadata(part().state)
  // Hide synthetic stop tool parts while keeping metadata available for exported diagnostics.
  const hideSyntheticStop = createMemo(
    () => partMetadata().diagnostics?.loop?.loopAction === "stop",
  )
  const taskId = createMemo(() => {
    if (part().tool !== "task" && part().tool !== "agent") return // agent-rename:legacy-render
    const value = partMetadata().sessionId
    if (typeof value === "string" && value) return value
  })
  const taskHref = createMemo(() => {
    if (part().tool !== "task" && part().tool !== "agent") return // agent-rename:legacy-render
    return sessionLink(taskId(), useLocation().pathname, data.sessionHref)
  })
  const taskSubtitle = createMemo(() => {
    if (part().tool !== "task" && part().tool !== "agent") return undefined // agent-rename:legacy-render
    const value = input().description
    if (typeof value === "string" && value) return value
    return taskId()
  })

  const render = createMemo(() => ToolRegistry.render(part().tool) ?? GenericTool)

  return (
    <Show when={!hideQuestion() && !hideSyntheticStop()}>
      <div data-component="tool-part-wrapper">
        <Switch>
          <Match when={part().state.status === "error" && toolStateError(part().state)}>
            {(error) => {
              const cleaned = error().replace("Error: ", "")
              if (part().tool === "question" && cleaned.includes("dismissed this question")) {
                return (
                  <div style="width: 100%; display: flex; justify-content: flex-end;">
                    <span class="text-body text-fg-weak cursor-default">
                      {i18n.t("ui.messagePart.questions.dismissed")}
                    </span>
                  </div>
                )
              }
              // Cancelled question: the run was interrupted before the user
              // saw or answered. Show a short, action-oriented hint instead of
              // the raw "Question cancelled..." string so non-technical users
              // know they can just re-ask. Identify by metadata.interrupted
              // (written by processor cleanup) so this is independent of the
              // exact error string used in the backend. See #419.
              if (part().tool === "question" && partMetadata()?.interrupted === true) {
                return (
                  <div style="width: 100%; display: flex; justify-content: flex-end;">
                    <span class="text-body text-fg-weak cursor-default">
                      {i18n.t("ui.messagePart.questions.interrupted")}
                    </span>
                  </div>
                )
              }
              const webSearchError = part().tool === "websearch" ? webSearchErrorDisplay(partMetadata(), i18n) : undefined
              return (
                <ToolErrorCard
                  tool={part().tool}
                  error={webSearchError?.error ?? error()}
                  defaultOpen={props.defaultOpen}
                  subtitle={webSearchError?.subtitle ?? taskSubtitle()}
                  href={taskHref()}
                />
              )
            }}
          </Match>
          <Match when={true}>
            <Dynamic
              component={render()}
              input={input()}
              tool={part().tool}
              metadata={partMetadata()}
              // @ts-expect-error
              output={part().state.output}
              status={part().state.status}
              hideDetails={props.hideDetails}
              defaultOpen={props.defaultOpen}
            />
          </Match>
        </Switch>
      </div>
    </Show>
  )
})
