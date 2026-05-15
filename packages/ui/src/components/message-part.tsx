import { useI18n } from "../context/i18n"
import { buildToolInfo, toolInfoForInput, type ToolInfo } from "./tool-info"
import "./message-part/parts"
import "./message-part/tools"

export { buildToolInfo, type ToolInfo }
export {
  PART_MAPPING,
  ToolRegistry,
  getTool,
  registerPartComponent,
  registerTool,
  type MessagePartProps,
  type MessageProps,
  type PartComponent,
  type SessionAction,
  type ToolComponent,
  type ToolProps,
  type UserActions,
} from "./message-part/registry"
export { AssistantParts } from "./message-part/assistant-parts"
export { AssistantMessageDisplay } from "./message-part/assistant-message-display"
export { Message, Part } from "./message-part/message-router"
export { UserMessageDisplay } from "./message-part/user-message"
export { MessageDivider } from "./message-part/parts/compaction-and-divider"

export function getToolInfo(tool: string, input: any = {}, metadata: any = {}): ToolInfo {
  return toolInfoForInput(tool, input, metadata, useI18n())
}
