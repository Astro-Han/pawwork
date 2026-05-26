import type { ToolPart } from "@opencode-ai/sdk/v2"
import { getFilename } from "@opencode-ai/core/util/path"
import type { UiI18n } from "../context/i18n"
import type { IconProps } from "./icon"
import {
  TOOL_AGENT,
  TOOL_AGENT_LEGACY,
  TOOL_QUESTION,
  TOOL_TODOWRITE,
  TOOL_WEBFETCH,
  TOOL_WEBSEARCH,
} from "./tool-contract"

export type ToolInfo = {
  icon: IconProps["name"]
  title: string
  subtitle?: string
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function enterWorktreeOwnerProject(metadata: Record<string, any> = {}): string | undefined {
  const owner = pickString(metadata.ownerDirectory)
  return owner ? getFilename(owner) : undefined
}

function enterWorktreeTarget(
  input: Record<string, any> = {},
  metadata: Record<string, any> = {},
): string | undefined {
  const activeDirectory = pickString(metadata.activeDirectory)
  return (
    pickString(metadata.branch) ||
    pickString(metadata.slug) ||
    pickString(input.name) ||
    (activeDirectory ? getFilename(activeDirectory) : undefined)
  )
}

export function enterWorktreeSubtitle(
  input: Record<string, any>,
  metadata: Record<string, any>,
  i18n: UiI18n,
): string | undefined {
  const project = enterWorktreeOwnerProject(metadata)
  const target = enterWorktreeTarget(input, metadata)
  if (target && project) return i18n.t("ui.tool.worktree.enter.fromProject", { project, target })
  return target || project
}

function exitWorktreeProjectName(metadata: Record<string, any> = {}): string | undefined {
  const dest = pickString(metadata.activeDirectory)
  return dest ? getFilename(dest) : undefined
}

function exitWorktreePreviousLabel(metadata: Record<string, any> = {}): string | undefined {
  return pickString(metadata.previousBranch) || pickString(metadata.previousSlug)
}

export function exitWorktreeSubtitle(metadata: Record<string, any>, i18n: UiI18n): string | undefined {
  const project = exitWorktreeProjectName(metadata)
  const previous = exitWorktreePreviousLabel(metadata)
  if (previous && project) return i18n.t("ui.tool.worktree.exit.fromWorktree", { previous, project })
  if (project) return i18n.t("ui.tool.worktree.exit.toProject", { project })
  return previous
}

function agentTitle(i18n: UiI18n, type?: string) {
  if (!type) return i18n.t("ui.tool.agent.default")
  return i18n.t("ui.tool.agent", { type })
}

export function toolInfoForInput(
  tool: string,
  input: Record<string, any> = {},
  metadata: Record<string, any> = {},
  i18n: UiI18n,
  options: { unknownSubtitle?: string } = {},
): ToolInfo {
  switch (tool) {
    case "read":
      return {
        icon: "glasses",
        title: i18n.t("ui.tool.read"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "list":
      return {
        icon: "bullet-list",
        title: i18n.t("ui.tool.list"),
        subtitle: input.path ? getFilename(input.path) : undefined,
      }
    case "glob":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.glob"),
        subtitle: input.pattern,
      }
    case "grep":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.grep"),
        subtitle: input.pattern,
      }
    case TOOL_WEBFETCH:
      return {
        icon: "window-cursor",
        title: i18n.t("ui.tool.webfetch"),
        subtitle: input.url,
      }
    case TOOL_WEBSEARCH:
      return {
        icon: "window-cursor",
        title: i18n.t("ui.tool.websearch"),
        subtitle: input.query,
      }
    case "enter-worktree": {
      return {
        icon: "worktree",
        title: i18n.t("ui.tool.worktree.enter"),
        subtitle: enterWorktreeSubtitle(input, metadata, i18n),
      }
    }
    case "exit-worktree": {
      return {
        icon: "worktree",
        title: i18n.t("ui.tool.worktree.exit"),
        subtitle: exitWorktreeSubtitle(metadata, i18n),
      }
    }
    case TOOL_AGENT_LEGACY: // agent-rename:legacy-render
    case TOOL_AGENT: {
      const type =
        typeof input.subagent_type === "string" && input.subagent_type
          ? input.subagent_type[0]!.toUpperCase() + input.subagent_type.slice(1)
          : undefined
      return {
        icon: "agent",
        title: agentTitle(i18n, type),
        subtitle: input.description,
      }
    }
    case "bash":
      return {
        icon: "console",
        title: i18n.t("ui.tool.shell"),
        subtitle: input.description,
      }
    case "edit":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.edit"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "write":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.write"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "apply_patch":
      const fileCount = Array.isArray(metadata.files)
        ? metadata.files.length
        : Array.isArray(input.files)
          ? input.files.length
          : 0
      return {
        icon: "code-lines",
        title: i18n.t("ui.tool.patch"),
        subtitle: fileCount
          ? `${fileCount} ${i18n.t(fileCount > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
          : undefined,
      }
    case TOOL_TODOWRITE:
      return {
        icon: "checklist",
        title: i18n.t("ui.tool.todos"),
      }
    case TOOL_QUESTION:
      return {
        icon: "bubble-5",
        title: i18n.t("ui.tool.questions"),
      }
    case "skill":
      return {
        icon: "brain",
        title: input.name || i18n.t("ui.tool.skill"),
      }
    default:
      return {
        icon: "mcp",
        title: tool,
        subtitle: options.unknownSubtitle,
      }
  }
}

export function buildToolInfo(part: ToolPart, i18n: UiI18n): ToolInfo {
  const input: any = part.state?.input ?? {}
  const metadata: any = (part.state as any)?.metadata ?? {}
  return toolInfoForInput(part.tool, input, metadata, i18n, { unknownSubtitle: "" })
}
