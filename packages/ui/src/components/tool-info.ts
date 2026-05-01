import type { ToolPart } from "@opencode-ai/sdk/v2"
import { getFilename } from "@opencode-ai/core/util/path"
import type { UiI18n } from "../context/i18n"
import type { IconProps } from "./icon"

export type ToolInfo = {
  icon: IconProps["name"]
  title: string
  subtitle?: string
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

export function enterWorktreeOwnerProject(metadata: Record<string, any> = {}): string | undefined {
  const owner = pickString(metadata.ownerDirectory)
  return owner ? getFilename(owner) : undefined
}

export function enterWorktreeTarget(
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

export function exitWorktreeProjectName(metadata: Record<string, any> = {}): string | undefined {
  const dest = pickString(metadata.activeDirectory)
  return dest ? getFilename(dest) : undefined
}

export function exitWorktreePreviousLabel(metadata: Record<string, any> = {}): string | undefined {
  return pickString(metadata.previousBranch) || pickString(metadata.previousSlug)
}

export function exitWorktreeSubtitle(metadata: Record<string, any>, i18n: UiI18n): string | undefined {
  const project = exitWorktreeProjectName(metadata)
  const previous = exitWorktreePreviousLabel(metadata)
  if (previous && project) return i18n.t("ui.tool.worktree.exit.fromWorktree", { previous, project })
  if (project) return i18n.t("ui.tool.worktree.exit.toProject", { project })
  return previous
}

export function agentTitle(i18n: UiI18n, type?: string) {
  if (!type) return i18n.t("ui.tool.agent.default")
  return i18n.t("ui.tool.agent", { type })
}

export function buildToolInfo(part: ToolPart, i18n: UiI18n): ToolInfo {
  const input: any = part.state?.input ?? {}
  const metadata: any = (part.state as any)?.metadata ?? {}
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
      return { icon: "magnifying-glass-menu", title: i18n.t("ui.tool.glob"), subtitle: input.pattern }
    case "grep":
      return { icon: "magnifying-glass-menu", title: i18n.t("ui.tool.grep"), subtitle: input.pattern }
    case "webfetch":
      return { icon: "window-cursor", title: i18n.t("ui.tool.webfetch"), subtitle: input.url }
    case "websearch":
      return { icon: "window-cursor", title: i18n.t("ui.tool.websearch"), subtitle: input.query }
    case "codesearch":
      return { icon: "code", title: i18n.t("ui.tool.codesearch"), subtitle: input.query }
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
    case "bash":
      return { icon: "console", title: i18n.t("ui.tool.shell"), subtitle: input.description }
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
