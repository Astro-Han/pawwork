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
import { TOOL_AGENT, TOOL_AGENT_LEGACY, TOOL_QUESTION, TOOL_TODOWRITE, TOOL_WEBSEARCH } from "../../tool-contract"

registerPartComponent("tool", function ToolPartDisplay(props) {
  const data = useData()
  const i18n = useI18n()
  const part = () => props.part as ToolPart
  if (part().tool === TOOL_TODOWRITE) return null

  // The dock surfaces pending / running question parts as the active input
  // surface (D1 = B, dock projection of running question tool parts). The
  // inline timeline either hides (flag-off legacy: dock is the only render
  // path) or shows a thin marker (flag-on: rendered by the Match below).
  // We detect flag-on via the new metadata flag set by ctx.externalResult.
  const isQuestion = () => part().tool === TOOL_QUESTION
  const isQuestionRunning = () =>
    isQuestion() && (part().state.status === "pending" || part().state.status === "running")
  const newQuestionPath = () => {
    const meta = partMetadata()
    return meta != null && Object.prototype.hasOwnProperty.call(meta, "externalResultReady")
  }
  // Flag-off (legacy): hide running questions in timeline so only the dock
  // renders. Flag-on: render the thin marker (no hide).
  const hideQuestion = createMemo(() => isQuestionRunning() && !newQuestionPath())

  const emptyInput: Record<string, any> = {}
  const emptyMetadata: Record<string, any> = {}

  const input = () => part().state?.input ?? emptyInput
  const partMetadata = () => toolStateMetadata(part().state)
  // Hide synthetic stop tool parts while keeping metadata available for exported diagnostics.
  const hideSyntheticStop = createMemo(
    () => partMetadata().diagnostics?.loop?.loopAction === "stop",
  )
  const taskId = createMemo(() => {
    if (part().tool !== TOOL_AGENT_LEGACY && part().tool !== TOOL_AGENT) return // agent-rename:legacy-render
    const value = partMetadata().sessionId
    if (typeof value === "string" && value) return value
  })
  const taskHref = createMemo(() => {
    if (part().tool !== TOOL_AGENT_LEGACY && part().tool !== TOOL_AGENT) return // agent-rename:legacy-render
    return sessionLink(taskId(), useLocation().pathname, data.sessionHref)
  })
  const taskSubtitle = createMemo(() => {
    if (part().tool !== TOOL_AGENT_LEGACY && part().tool !== TOOL_AGENT) return undefined // agent-rename:legacy-render
    const value = input().description
    if (typeof value === "string" && value) return value
    return taskId()
  })

  const render = createMemo(() => ToolRegistry.render(part().tool) ?? GenericTool)

  return (
    <Show when={!hideQuestion() && !hideSyntheticStop()}>
      <div data-component="tool-part-wrapper">
        <Switch>
          {/* Flag-on question, running: thin marker pointing to dock (D1 = B
              two-surface rule). The dock holds the active input controls; the
              inline timeline only signals "there is a pending question". */}
          <Match when={isQuestion() && newQuestionPath() && isQuestionRunning()}>
            <div data-component="question-inline-marker" style="width: 100%; display: flex; justify-content: flex-end;">
              <span class="text-body text-fg-weak cursor-default">
                {i18n.t("ui.messagePart.questions.pendingMarker")}
              </span>
            </div>
          </Match>
          {/* Flag-on question, completed dismiss: keyed on metadata.dismissed
              (NOT on answers.length, since all-blank submit is a legitimate
              non-dismiss case). Do NOT also gate on newQuestionPath() — the
              `externalResultReady` flag lives on the running tool part's
              state.metadata and is replaced when the writer flips state to
              "completed", so this branch would otherwise be unreachable.
              `metadata.dismissed === true` is unique to the new path (the
              legacy dismiss flow routes through the error branch). */}
          <Match
            when={
              isQuestion() &&
              part().state.status === "completed" &&
              partMetadata()?.dismissed === true
            }
          >
            <div style="width: 100%; display: flex; justify-content: flex-end;">
              <span class="text-body text-fg-weak cursor-default">
                {i18n.t("ui.messagePart.questions.dismissed")}
              </span>
            </div>
          </Match>
          <Match when={part().state.status === "error" && toolStateError(part().state)}>
            {(error) => {
              // Typed reason branches (set when the new path's writer wiring
              // populates ToolStateError.reason). Legacy parts without reason
              // fall through to the substring fallback below for back-compat.
              const reason =
                part().state.status === "error" && "reason" in part().state
                  ? ((part().state as { reason?: "aborted" | "shutdown" | "tool_failure" }).reason)
                  : undefined
              if (isQuestion() && reason === "aborted") {
                return (
                  <div style="width: 100%; display: flex; justify-content: flex-end;">
                    <span class="text-body text-fg-weak cursor-default">
                      {i18n.t("ui.messagePart.questions.interrupted")}
                    </span>
                  </div>
                )
              }
              if (isQuestion() && reason === "shutdown") {
                return (
                  <div style="width: 100%; display: flex; justify-content: flex-end;">
                    <span class="text-body text-fg-weak cursor-default">
                      {i18n.t("ui.messagePart.questions.interrupted")}
                    </span>
                  </div>
                )
              }
              const cleaned = error().replace("Error: ", "")
              if (part().tool === TOOL_QUESTION && cleaned.includes("dismissed this question")) {
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
              if (part().tool === TOOL_QUESTION && partMetadata()?.interrupted === true) {
                return (
                  <div style="width: 100%; display: flex; justify-content: flex-end;">
                    <span class="text-body text-fg-weak cursor-default">
                      {i18n.t("ui.messagePart.questions.interrupted")}
                    </span>
                  </div>
                )
              }
              const webSearchError =
                part().tool === TOOL_WEBSEARCH ? webSearchErrorDisplay(partMetadata(), i18n) : undefined
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
