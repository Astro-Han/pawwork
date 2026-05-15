import { createMemo, Show } from "solid-js"
import { useLocation } from "@solidjs/router"
import { useData } from "../../../context"
import { useI18n } from "../../../context/i18n"
import { BasicTool } from "../../basic-tool"
import { Icon } from "../../icon"
import { Spinner } from "../../spinner"
import { TextShimmer } from "../../text-shimmer"
import { taskAgent } from "../agent-tone"
import { sessionLink, taskSession } from "../session-link"
import { ToolRegistry, type ToolComponent } from "../registry"

// Render function extracted so both "task" (legacy) and "agent" registrations share one reference.
const renderAgentToolPart: ToolComponent = (props) => {
  const data = useData()
  const i18n = useI18n()
  const location = useLocation()
  const childSessionId = createMemo(() => {
    const value = props.metadata.sessionId
    if (typeof value === "string" && value) return value
    return taskSession(props.input, location.pathname, data.store.session, data.store.agent)
  })
  const agent = createMemo(() => taskAgent(props.input.subagent_type, data.store.agent))
  const title = createMemo(() => agent().name ?? i18n.t("ui.tool.agent.default"))
  const tone = createMemo(() => agent().color)
  const subtitle = createMemo(() => {
    const value = props.input.description
    if (typeof value === "string" && value) return value
    return childSessionId()
  })
  const running = createMemo(() => props.status === "pending" || props.status === "running")

  const href = createMemo(() => sessionLink(childSessionId(), location.pathname, data.sessionHref))
  const clickable = createMemo(() => !!(childSessionId() && (data.navigateToSession || href())))

  const open = () => {
    const id = childSessionId()
    if (!id) return
    if (data.navigateToSession) {
      data.navigateToSession(id)
      return
    }
    const value = href()
    if (value) window.location.assign(value)
  }

  const navigate = (event: MouseEvent) => {
    if (!data.navigateToSession) return
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    event.preventDefault()
    open()
  }

  const trigger = () => (
    <div data-component="task-tool-card">
      <div data-slot="basic-tool-tool-info-structured">
        <div data-slot="basic-tool-tool-info-main">
          <Show when={running()}>
            <span data-component="task-tool-spinner" style={{ color: tone() ?? "var(--brand-primary)" }}>
              <Spinner />
            </span>
          </Show>
          <span data-component="task-tool-title" style={{ color: tone() ?? "var(--fg-strong)" }}>
            {title()}
          </span>
          <Show when={subtitle()}>
            <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>
          </Show>
        </div>
      </div>
      <Show when={clickable()}>
        <div data-component="task-tool-action">
          <Icon name="square-arrow-top-right" />
        </div>
      </Show>
    </div>
  )

  return (
    <BasicTool
      icon="agent"
      status={props.status}
      trigger={trigger()}
      hideDetails
      triggerHref={href()}
      clickable={clickable()}
      onTriggerClick={navigate}
    />
  )
}

ToolRegistry.register({ name: "task", render: renderAgentToolPart }) // agent-rename:legacy-render
ToolRegistry.register({ name: "agent", render: renderAgentToolPart })
