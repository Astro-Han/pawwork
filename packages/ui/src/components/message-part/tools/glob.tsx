import { Show } from "solid-js"
import { useI18n } from "../../../context/i18n"
import { BasicTool } from "../../basic-tool"
import { toolIcon } from "../../tool-info"
import { getDirectory, MessageMarkdown } from "../markdown-render"
import { ToolRegistry } from "../registry"

ToolRegistry.register({
  name: "glob",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        icon={toolIcon("glob")}
        trigger={{
          title: i18n.t("ui.tool.glob"),
          subtitle: getDirectory(props.input.path || "/"),
          args: props.input.pattern ? ["pattern=" + props.input.pattern] : [],
        }}
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
