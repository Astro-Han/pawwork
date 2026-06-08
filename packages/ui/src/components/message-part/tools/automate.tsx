import { createMemo, Show } from "solid-js"
import { useData } from "../../../context"
import { useI18n } from "../../../context/i18n"
import { BasicTool } from "../../basic-tool"
import { Icon } from "../../icon"
import { Spinner } from "../../spinner"
import { ToolRegistry, type ToolComponent } from "../registry"

// "automate" tool card: when the agent creates an automation in chat, echo a
// lightweight confirmation with a jump into the Automations panel. The resolved
// definition comes from tool metadata (see opencode tool/automate.ts), never
// parsed from prose. Navigation goes through the data context (like the
// agent/task card's navigateToSession), so this stays app-agnostic.
const renderAutomateToolPart: ToolComponent = (props) => {
  const data = useData()
  const i18n = useI18n()

  const definition = createMemo(() => {
    const value = props.metadata.automationDefinition
    if (value && typeof value === "object")
      return value as { id?: string; title?: string; context?: "continue" | "fresh" }
    return undefined
  })
  const automationID = createMemo(() => {
    const id = definition()?.id
    return typeof id === "string" && id ? id : undefined
  })
  const subtitle = createMemo(() => {
    const title = definition()?.title
    if (typeof title === "string" && title) return title
    const input = props.input.title
    return typeof input === "string" && input ? input : undefined
  })
  // Once the definition resolves, flag whether this automation reuses its own
  // persistent session ("continue") or starts fresh each run, so the chat echo
  // does not hide that a continue automation accumulates context across runs.
  const sessionMode = createMemo(() => {
    const context = definition()?.context
    if (context !== "continue" && context !== "fresh") return undefined
    return context === "continue"
      ? i18n.t("ui.tool.automate.session.continue")
      : i18n.t("ui.tool.automate.session.fresh")
  })
  const running = createMemo(() => props.status === "pending" || props.status === "running")
  const clickable = createMemo(() => !!(automationID() && data.navigateToAutomation))

  const open = () => {
    const id = automationID()
    if (id && data.navigateToAutomation) data.navigateToAutomation(id)
  }

  const navigate = (event: MouseEvent) => {
    if (!clickable()) return
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    event.preventDefault()
    open()
  }

  const trigger = () => (
    <div data-component="automate-tool-card">
      <div data-slot="basic-tool-tool-info-structured">
        <div data-slot="basic-tool-tool-info-main">
          <Show when={running()}>
            <span data-component="automate-tool-spinner" style={{ color: "var(--brand-primary)" }}>
              <Spinner />
            </span>
          </Show>
          <span data-component="automate-tool-title" style={{ color: "var(--fg-strong)" }}>
            {running() ? i18n.t("ui.tool.automate.creating") : i18n.t("ui.tool.automate.created")}
          </span>
          <Show when={subtitle()}>
            <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>
          </Show>
        </div>
        <Show when={sessionMode()}>
          <span data-component="automate-tool-session" style={{ color: "var(--fg-weak)" }}>
            {sessionMode()}
          </span>
        </Show>
      </div>
      <Show when={clickable()}>
        <div data-component="automate-tool-action">
          <Icon name="square-arrow-top-right" />
        </div>
      </Show>
    </div>
  )

  return (
    <BasicTool
      icon="automation"
      status={props.status}
      trigger={trigger()}
      hideDetails
      clickable={clickable()}
      onTriggerClick={navigate}
    />
  )
}

ToolRegistry.register({ name: "automate", render: renderAutomateToolPart })
