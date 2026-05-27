import { createMemo, Show } from "solid-js"
import { useI18n } from "../../../context/i18n"
import { BasicTool } from "../../basic-tool"
import { toolIcon } from "../../tool-info"
import { Icon } from "../../icon"
import { TextShimmer } from "../../text-shimmer"
import { ToolRegistry } from "../registry"

ToolRegistry.register({
  name: "webfetch",
  render(props) {
    const i18n = useI18n()
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const url = createMemo(() => {
      const value = props.input.url
      if (typeof value !== "string") return ""
      try {
        const parsed = new URL(value)
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return ""
        return parsed.toString()
      } catch {
        return ""
      }
    })
    return (
      <BasicTool
        {...props}
        hideDetails
        icon={toolIcon("webfetch")}
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.webfetch")} active={pending()} />
              </span>
              <Show when={!pending() && url()}>
                <a
                  data-slot="basic-tool-tool-subtitle"
                  class="clickable subagent-link"
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  {url()}
                </a>
              </Show>
            </div>
            <Show when={!pending() && url()}>
              <div data-component="tool-action">
                <Icon name="square-arrow-top-right" />
              </div>
            </Show>
          </div>
        }
      />
    )
  },
})
