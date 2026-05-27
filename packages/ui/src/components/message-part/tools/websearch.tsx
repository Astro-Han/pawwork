import { createMemo, For, Show } from "solid-js"
import { useI18n } from "../../../context/i18n"
import { BasicTool } from "../../basic-tool"
import { toolIcon } from "../../tool-info"
import { urls } from "../session-link"
import { ToolRegistry } from "../registry"

function ExaOutput(props: { output?: string }) {
  const links = createMemo(() => urls(props.output))

  return (
    <Show when={links().length > 0}>
      <div data-component="exa-tool-output">
        <div data-slot="exa-tool-links">
          <For each={links()}>
            {(url) => (
              <a
                data-slot="exa-tool-link"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
              >
                {url}
              </a>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

ToolRegistry.register({
  name: "websearch",
  render(props) {
    const i18n = useI18n()
    const query = createMemo(() => {
      const value = props.input.query
      if (typeof value !== "string") return ""
      return value
    })

    return (
      <BasicTool
        {...props}
        icon={toolIcon("websearch")}
        trigger={{
          title: i18n.t("ui.tool.websearch"),
          subtitle: query(),
          subtitleClass: "exa-tool-query",
        }}
      >
        <ExaOutput output={props.output} />
      </BasicTool>
    )
  },
})
