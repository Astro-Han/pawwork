import { Show } from "solid-js"
import { useI18n } from "../../../context/i18n"
import { BasicTool } from "../../basic-tool"
import { toolIcon } from "../../tool-info"
import { getDirectory, MessageMarkdown } from "../markdown-render"
import { ToolRegistry } from "../registry"

ToolRegistry.register({
  name: "grep",
  render(props) {
    const i18n = useI18n()
    const args: string[] = []
    if (props.input.pattern) args.push("pattern=" + props.input.pattern)
    if (props.input.include) args.push("include=" + props.input.include)
    return (
      <BasicTool
        {...props}
        icon={toolIcon("grep")}
        trigger={{
          title: i18n.t("ui.tool.grep"),
          subtitle: getDirectory(props.input.path || "/"),
          args,
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
