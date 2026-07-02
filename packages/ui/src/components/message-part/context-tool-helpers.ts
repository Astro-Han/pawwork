import type { ToolPart } from "@opencode-ai/sdk/v2"
import { getFilename } from "@opencode-ai/core/util/path"
import type { UiI18n, UiI18nKey } from "../../context/i18n"
import { getDirectory } from "./markdown-render"
import { toolInfoForInput } from "../tool-info"

const TOOL_ERROR_DETAIL_MAX = 120

export function contextToolDetail(part: ToolPart, i18n: UiI18n): string | undefined {
  const info = toolInfoForInput(part.tool, part.state.input ?? {}, toolStateMetadata(part.state), i18n)
  if (info.subtitle) return info.subtitle
  if (part.state.status === "error") return boundedToolStateError(part.state)
  if ((part.state.status === "running" || part.state.status === "completed") && part.state.title)
    return part.state.title
  const description = part.state.input?.description
  if (typeof description === "string") return description
  return undefined
}

export function contextToolTrigger(part: ToolPart, i18n: UiI18n) {
  const input = (part.state.input ?? {}) as Record<string, unknown>
  const path = typeof input.path === "string" ? input.path : "/"
  const filePath = typeof input.filePath === "string" ? input.filePath : undefined
  const pattern = typeof input.pattern === "string" ? input.pattern : undefined
  const include = typeof input.include === "string" ? input.include : undefined
  const offset = typeof input.offset === "number" ? input.offset : undefined
  const limit = typeof input.limit === "number" ? input.limit : undefined

  switch (part.tool) {
    case "read": {
      const args: string[] = []
      if (offset !== undefined) args.push("offset=" + offset)
      if (limit !== undefined) args.push("limit=" + limit)
      return {
        title: i18n.t("ui.tool.read"),
        subtitle: filePath ? getFilename(filePath) : "",
        args,
      }
    }
    case "list":
      return {
        title: i18n.t("ui.tool.list"),
        subtitle: getDirectory(path),
      }
    case "glob":
      return {
        title: i18n.t("ui.tool.glob"),
        subtitle: getDirectory(path),
        args: pattern ? ["pattern=" + pattern] : [],
      }
    case "grep": {
      const args: string[] = []
      if (pattern) args.push("pattern=" + pattern)
      if (include) args.push("include=" + include)
      return {
        title: i18n.t("ui.tool.grep"),
        subtitle: getDirectory(path),
        args,
      }
    }
    default: {
      const info = toolInfoForInput(part.tool, input, toolStateMetadata(part.state), i18n)
      return {
        title: info.title,
        subtitle: info.subtitle || contextToolDetail(part, i18n),
        args: [],
      }
    }
  }
}

export function contextToolSummaryText(part: ToolPart, i18n: UiI18n) {
  const trigger = contextToolTrigger(part, i18n)
  return [trigger.title, trigger.subtitle, ...(trigger.args ?? [])].filter(Boolean).join(" ")
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

function boundedToolStateError(state: ToolPart["state"] | undefined): string | undefined {
  const error = toolStateError(state)?.replace(/\s+/g, " ").trim()
  if (!error) return undefined
  if (error.length <= TOOL_ERROR_DETAIL_MAX) return error
  return `${error.slice(0, TOOL_ERROR_DETAIL_MAX - 3)}...`
}

export function contextToolSummary(parts: ToolPart[]) {
  const read = parts.filter((part) => part.tool === "read").length
  const search = parts.filter((part) => part.tool === "glob" || part.tool === "grep").length
  const list = parts.filter((part) => part.tool === "list").length
  return { read, search, list }
}

type TrowActivityKind = "read" | "search" | "websearch" | "webfetch" | "edit" | "command" | "browser" | "tool"

function trowActivityKind(tool: string): TrowActivityKind {
  switch (tool) {
    case "read":
    case "list":
      return "read"
    case "glob":
    case "grep":
      return "search"
    case "websearch":
      return "websearch"
    case "webfetch":
      return "webfetch"
    case "edit":
    case "write":
    case "apply_patch":
      return "edit"
    case "bash":
      return "command"
    default:
      return tool.startsWith("browser_") ? "browser" : "tool"
  }
}

function trowActivityCount(part: ToolPart): number {
  if (part.tool !== "apply_patch") return 1
  const files = toolStateMetadata(part.state).files
  return Array.isArray(files) && files.length > 0 ? files.length : 1
}

function trowSummaryKey(kind: TrowActivityKind, count: number) {
  return `ui.sessionTurn.trow.summary.${kind}.${count === 1 ? "one" : "other"}` as UiI18nKey
}

function trowFailedKey(count: number) {
  return `ui.sessionTurn.trow.summary.failed.${count === 1 ? "one" : "other"}` as UiI18nKey
}

function trowSummarySeparator(i18n: UiI18n) {
  return i18n.locale().startsWith("zh") ? "，" : ", "
}

export function contextTrowSummaryText(parts: readonly ToolPart[], failedCount: number, i18n: UiI18n) {
  const order: TrowActivityKind[] = []
  const counts = new Map<TrowActivityKind, number>()
  for (const part of parts) {
    const kind = trowActivityKind(part.tool)
    if (!counts.has(kind)) order.push(kind)
    counts.set(kind, (counts.get(kind) ?? 0) + trowActivityCount(part))
  }

  const items = order.map((kind) => {
    const count = counts.get(kind) ?? 0
    return i18n.t(trowSummaryKey(kind, count), { count })
  })
  if (failedCount > 0) items.push(i18n.t(trowFailedKey(failedCount), { count: failedCount }))
  return items.join(trowSummarySeparator(i18n))
}
