import type { ToolPart } from "@opencode-ai/sdk/v2"
import { getFilename } from "@opencode-ai/shared/util/path"
import type { UiI18n } from "../context/i18n"
import type { IconProps } from "./icon"

export type ToolInfo = {
  icon: IconProps["name"]
  title: string
  subtitle?: string
}

export function agentTitle(i18n: UiI18n, type?: string) {
  if (!type) return i18n.t("ui.tool.agent.default")
  return i18n.t("ui.tool.agent", { type })
}

export function buildToolInfo(part: ToolPart, i18n: UiI18n): ToolInfo {
  const input: any = part.state?.input ?? {}
  switch (part.tool) {
    case "task": // agent-rename:legacy-render
    case "agent": {
      const subagentType = typeof input?.subagent_type === "string" ? input.subagent_type : undefined
      const type = subagentType ? subagentType[0]!.toUpperCase() + subagentType.slice(1) : undefined
      return {
        icon: "agent",
        title: agentTitle(i18n, type),
        subtitle: input?.description || undefined,
      }
    }
    case "read":
      return { icon: "glasses", title: i18n.t("ui.tool.read"), subtitle: input.filePath ? getFilename(input.filePath) : undefined }
    case "list":
      return { icon: "bullet-list", title: i18n.t("ui.tool.list"), subtitle: input.path ? getFilename(input.path) : undefined }
    case "glob":
      return { icon: "magnifying-glass-menu", title: i18n.t("ui.tool.glob"), subtitle: input.pattern }
    case "grep":
      return { icon: "magnifying-glass-menu", title: i18n.t("ui.tool.grep"), subtitle: input.pattern }
    case "webfetch":
      return { icon: "window-cursor", title: i18n.t("ui.tool.webfetch"), subtitle: input.url }
    case "websearch":
      return { icon: "window-cursor", title: i18n.t("ui.tool.websearch"), subtitle: input.query }
    case "codesearch":
      return { icon: "code", title: i18n.t("ui.tool.codesearch"), subtitle: input.query }
    case "bash":
      return { icon: "console", title: i18n.t("ui.tool.shell"), subtitle: input.description }
    case "edit":
      return { icon: "code-lines", title: i18n.t("ui.messagePart.title.edit"), subtitle: input.filePath ? getFilename(input.filePath) : undefined }
    case "write":
      return { icon: "code-lines", title: i18n.t("ui.messagePart.title.write"), subtitle: input.filePath ? getFilename(input.filePath) : undefined }
    case "apply_patch":
      return {
        icon: "code-lines",
        title: i18n.t("ui.tool.patch"),
        subtitle: input.files?.length
          ? `${input.files.length} ${i18n.t(input.files.length > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
          : undefined,
      }
    case "todowrite":
      return { icon: "checklist", title: i18n.t("ui.tool.todos") }
    case "question":
      return { icon: "bubble-5", title: i18n.t("ui.tool.questions") }
    case "skill":
      return { icon: "brain", title: input.name || i18n.t("ui.tool.skill") }
    default:
      return { icon: "mcp", title: part.tool, subtitle: "" }
  }
}
