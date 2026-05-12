import { createMemo, Show } from "solid-js"
import { useLocation } from "@solidjs/router"
import { useData } from "../context"
import { useI18n } from "../context/i18n"
import { BasicTool } from "./basic-tool"
import { Icon } from "./icon"
import { Spinner } from "./spinner"
import { ToolRegistry } from "./message-part-registry"
import type { ToolComponent } from "./message-part-types"
import { taskAgent } from "./message-part-tool-info"
import { sessionLink, taskSession } from "./message-part-session-link"

/**
 * Slice 11b.1: task / agent tool renderer extracted from
 * `message-part.tsx`. Both the legacy `task` tool name and the renamed
 * `agent` registration share one `renderAgentToolPart` reference so the
 * card stays identical regardless of which name the model emits.
 *
 * The renderer resolves the spawned child session id from either
 * `metadata.sessionId` or by walking the store via `taskSession`, then
 * renders a clickable agent card that opens the child session
 * (`data.navigateToSession` when available, otherwise `window.location`).
 */

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
