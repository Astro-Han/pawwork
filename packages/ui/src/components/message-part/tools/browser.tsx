import { createMemo } from "solid-js"
import { useI18n } from "../../../context/i18n"
import { BasicTool } from "../../basic-tool"
import { toolInfoForInput } from "../../tool-info"
import { BROWSER_TOOL_NAMES } from "../../tool-contract"
import { ToolRegistry, type ToolComponent } from "../registry"

// All six embedded-browser tools share one card. Icon, title, and subtitle come
// from the shared toolInfoForInput map (single source of truth with the trow
// summary), so a browser_* call reads as "Open Page — example.com" rather than
// the generic "Called browser_navigate". Like webfetch/automate, the card has no
// expandable body: the result text is already in the model's context, and a
// screenshot renders as its own image part.
const renderBrowserToolPart: ToolComponent = (props) => {
  const i18n = useI18n()
  const info = createMemo(() => toolInfoForInput(props.tool, props.input, props.metadata, i18n))
  return (
    <BasicTool
      icon={info().icon}
      status={props.status}
      hideDetails
      trigger={{ title: info().title, subtitle: info().subtitle }}
    />
  )
}

for (const name of BROWSER_TOOL_NAMES) ToolRegistry.register({ name, render: renderBrowserToolPart })
