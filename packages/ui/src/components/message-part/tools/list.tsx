import { Show } from "solid-js"
import { useI18n } from "../../../context/i18n"
import { BasicTool } from "../../basic-tool"
import { getDirectory, MessageMarkdown } from "../markdown-render"
import { ToolRegistry } from "../registry"

ToolRegistry.register({
  name: "list",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        icon="bullet-list"
        trigger={{ title: i18n.t("ui.tool.list"), subtitle: getDirectory(props.input.path || "/") }}
      >
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <MessageMarkdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})
