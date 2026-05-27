import { createMemo } from "solid-js"
import { useI18n } from "../../../context/i18n"
import { BasicTool } from "../../basic-tool"
import { enterWorktreeSubtitle, exitWorktreeSubtitle, toolIcon } from "../../tool-info"
import { ToolRegistry } from "../registry"

ToolRegistry.register({
  name: "enter-worktree",
  render(props) {
    const i18n = useI18n()
    const subtitle = createMemo(() => enterWorktreeSubtitle(props.input, props.metadata, i18n))
    return (
      <BasicTool
        {...props}
        hideDetails
        icon={toolIcon("enter-worktree")}
        trigger={{ title: i18n.t("ui.tool.worktree.enter"), subtitle: subtitle() }}
      />
    )
  },
})

ToolRegistry.register({
  name: "exit-worktree",
  render(props) {
    const i18n = useI18n()
    const subtitle = createMemo(() => exitWorktreeSubtitle(props.metadata, i18n))
    return (
      <BasicTool
        {...props}
        hideDetails
        icon={toolIcon("exit-worktree")}
        trigger={{ title: i18n.t("ui.tool.worktree.exit"), subtitle: subtitle() }}
      />
    )
  },
})
