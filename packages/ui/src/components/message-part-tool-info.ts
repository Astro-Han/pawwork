import type { ToolPart } from "@opencode-ai/sdk/v2"
import { getFilename } from "@opencode-ai/core/util/path"
import { useI18n } from "../context/i18n"
import { agentTitle, enterWorktreeSubtitle, exitWorktreeSubtitle, type ToolInfo } from "./tool-info"

/**
 * Slice 11b.1: tool-info helpers extracted from `message-part.tsx`.
 *
 *   `getToolInfo`            i18n-aware factory: tool → icon/title/subtitle.
 *                            Must be called inside a Solid render scope
 *                            because it pulls from `useI18n()`.
 *   `toolStateMetadata`      narrow `ToolPart.state` to its metadata
 *                            record (defaults to `{}`).
 *   `toolStateError`         narrow `ToolPart.state` to its error
 *                            message, stringifying objects defensively.
 *   `taskAgent`              resolve a `task` / `agent` tool's display
 *                            name + tone color from the SDK's free-form
 *                            `subagent_type` string.
 *
 * `agentTones` / `agentPalette` / `tone()` are private to the agent
 * resolver — exported for the renderer module that still wants palette
 * access.
 */

export const agentTones: Record<string, string> = {
  ask: "var(--icon-agent-ask-base)",
  build: "var(--icon-agent-build-base)",
  docs: "var(--icon-agent-docs-base)",
  plan: "var(--icon-agent-plan-base)",
}

export const agentPalette = [
  "var(--icon-agent-ask-base)",
  "var(--icon-agent-build-base)",
  "var(--icon-agent-docs-base)",
  "var(--icon-agent-plan-base)",
  "var(--syntax-info)",
  "var(--syntax-success)",
  "var(--syntax-warning)",
  "var(--syntax-property)",
  "var(--syntax-constant)",
  "var(--success-text)",
  "var(--error-text)",
  "var(--warning)",
]

export function tone(name: string) {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return agentPalette[hash % agentPalette.length]
}

export function taskAgent(
  raw: unknown,
  list?: readonly { name: string; color?: string }[],
): { name?: string; color?: string } {
  if (typeof raw !== "string" || !raw) return {}
  const key = raw.toLowerCase()
  const item = list?.find((entry) => entry.name === raw || entry.name.toLowerCase() === key)
  return {
    name: item?.name ?? `${raw[0]!.toUpperCase()}${raw.slice(1)}`,
    color: item?.color ?? agentTones[key] ?? tone(key),
  }
}

export function getToolInfo(tool: string, input: any = {}, metadata: any = {}): ToolInfo {
  const i18n = useI18n()
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
    case "webfetch":
      return {
        icon: "window-cursor",
        title: i18n.t("ui.tool.webfetch"),
        subtitle: input.url,
      }
    case "websearch":
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
    case "task": // agent-rename:legacy-render
    case "agent": {
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
      return {
        icon: "code-lines",
        title: i18n.t("ui.tool.patch"),
        subtitle: input.files?.length
          ? `${input.files.length} ${i18n.t(input.files.length > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
          : undefined,
      }
    case "todowrite":
      return {
        icon: "checklist",
        title: i18n.t("ui.tool.todos"),
      }
    case "question":
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
      }
  }
}

export function toolStateMetadata(state: ToolPart["state"] | undefined): Record<string, any> {
  if (!state || !("metadata" in state)) return {}
  const metadata = state.metadata
  return metadata && typeof metadata === "object" ? metadata : {}
}

export function toolStateError(state: ToolPart["state"] | undefined): string | undefined {
  if (!state || !("error" in state)) return undefined
  const err: unknown = state.error
  if (typeof err === "string") return err
  if (err instanceof Error) return err.message || String(err)
  if (err == null) return undefined
  try {
    return JSON.stringify(err) || String(err)
  } catch {
    return String(err)
  }
}
