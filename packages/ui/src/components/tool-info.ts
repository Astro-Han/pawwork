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

/**
 * Single source of truth for a tool's icon.
 *
 * Every tool surface resolves its icon through here so they never drift:
 * the trow-block leading icon (`toolFamilyIcon` delegates to this), the
 * expanded tool header ({@link toolInfoForInput} returns it), and each
 * individual tool component (read/edit/write/apply-patch/skill passes
 * `toolIcon("…")` to BasicTool). Returns `mcp` for any unknown tool.
 */
export function toolIcon(tool: string): IconProps["name"] {
  switch (tool) {
    case "read":
      return "read-file"
    case "list":
      return "bullet-list"
    case "glob":
    case "grep":
      return "magnifying-glass-menu"
    case TOOL_WEBFETCH:
    case TOOL_WEBSEARCH:
      return "window-cursor"
    case "enter-worktree":
    case "exit-worktree":
      return "worktree"
    case TOOL_AGENT_LEGACY:
    case TOOL_AGENT:
      return "agent"
    case "bash":
      return "console"
    case "edit":
    case "write":
    case "apply_patch":
      return "edit"
    case TOOL_TODOWRITE:
      return "checklist"
    case TOOL_QUESTION:
      return "bubble-5"
    case "skill":
      return "skill"
    case "browser_navigate":
    case "browser_snapshot":
    case "browser_click":
    case "browser_type":
    case "browser_wait":
    case "browser_screenshot":
    case "browser_extract":
      return "browser"
    default:
      return "mcp"
  }
}

const BROWSER_TOOL_TITLE_KEYS = {
  browser_navigate: "ui.tool.browser.navigate",
  browser_snapshot: "ui.tool.browser.snapshot",
  browser_click: "ui.tool.browser.click",
  browser_type: "ui.tool.browser.type",
  browser_wait: "ui.tool.browser.wait",
  browser_screenshot: "ui.tool.browser.screenshot",
  browser_extract: "ui.tool.browser.extract",
} as const

function browserToolSubtitle(tool: string, input: Record<string, any>, metadata: Record<string, any>) {
  switch (tool) {
    case "browser_navigate":
      return pickString(metadata.url) ?? pickString(input.url)
    case "browser_click":
    case "browser_type":
      return pickString(input.ref)
    case "browser_wait":
      return pickString(input.text) ?? pickString(input.selector)
    case "browser_extract":
      return pickString(input.selector) ?? pickString(metadata.url)
    default:
      return pickString(metadata.url)
  }
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
  const icon = toolIcon(tool)
  switch (tool) {
    case "read":
      return {
        icon,
        title: i18n.t("ui.tool.read"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "list":
      return {
        icon,
        title: i18n.t("ui.tool.list"),
        subtitle: input.path ? getFilename(input.path) : undefined,
      }
    case "glob":
      return {
        icon,
        title: i18n.t("ui.tool.glob"),
        subtitle: input.pattern,
      }
    case "grep":
      return {
        icon,
        title: i18n.t("ui.tool.grep"),
        subtitle: input.pattern,
      }
    case TOOL_WEBFETCH:
      return {
        icon,
        title: i18n.t("ui.tool.webfetch"),
        subtitle: input.url,
      }
    case TOOL_WEBSEARCH:
      return {
        icon,
        title: i18n.t("ui.tool.websearch"),
        subtitle: input.query,
      }
    case "enter-worktree": {
      return {
        icon,
        title: i18n.t("ui.tool.worktree.enter"),
        subtitle: enterWorktreeSubtitle(input, metadata, i18n),
      }
    }
    case "exit-worktree": {
      return {
        icon,
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
        icon,
        title: agentTitle(i18n, type),
        subtitle: input.description,
      }
    }
    case "bash":
      return {
        icon,
        title: i18n.t("ui.tool.shell"),
        subtitle: input.description,
      }
    case "edit":
      return {
        icon,
        title: i18n.t("ui.messagePart.title.edit"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "write":
      return {
        icon,
        title: i18n.t("ui.messagePart.title.write"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "apply_patch": {
      const fileCount = Array.isArray(metadata.files)
        ? metadata.files.length
        : Array.isArray(input.files)
          ? input.files.length
          : 0
      return {
        icon,
        title: i18n.t("ui.tool.patch"),
        subtitle: fileCount
          ? `${fileCount} ${i18n.t(fileCount > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
          : undefined,
      }
    }
    case TOOL_TODOWRITE: {
      const todoCount = Array.isArray(input.todos) ? input.todos.length : 0
      return {
        icon,
        title: i18n.t("ui.tool.todos"),
        subtitle: todoCount
          ? `${todoCount} ${i18n.t(todoCount > 1 ? "ui.common.todo.other" : "ui.common.todo.one")}`
          : undefined,
      }
    }
    case TOOL_QUESTION: {
      const count = Array.isArray(input.questions) ? input.questions.length : 0
      return {
        icon,
        title: i18n.t("ui.tool.questions"),
        subtitle: count
          ? `${count} ${i18n.t(count > 1 ? "ui.common.question.other" : "ui.common.question.one")}`
          : undefined,
      }
    }
    case "skill":
      return {
        icon,
        title: input.name || i18n.t("ui.tool.skill"),
      }
    case "browser_navigate":
    case "browser_snapshot":
    case "browser_click":
    case "browser_type":
    case "browser_wait":
    case "browser_screenshot":
    case "browser_extract":
      return {
        icon,
        title: i18n.t(BROWSER_TOOL_TITLE_KEYS[tool]),
        subtitle: browserToolSubtitle(tool, input, metadata),
      }
    default:
      return {
        icon,
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
