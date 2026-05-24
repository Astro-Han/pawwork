import { createMemo } from "solid-js"
import { useI18n } from "../../../context/i18n"
import { BasicTool } from "../../basic-tool"
import { ToolRegistry } from "../registry"

ToolRegistry.register({
  name: "skill",
  render(props) {
    const i18n = useI18n()
    const skillName = createMemo(() => {
      const value = props.input.name
      return typeof value === "string" && value ? value : undefined
    })

    return (
      <BasicTool
        icon="brain"
        status={props.status}
        trigger={{ title: i18n.t("ui.tool.skill"), subtitle: skillName() }}
        hideDetails
      />
    )
  },
})
