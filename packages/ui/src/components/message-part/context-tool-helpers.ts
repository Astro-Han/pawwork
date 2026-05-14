import type { ToolPart } from "@opencode-ai/sdk/v2"
import { getFilename } from "@opencode-ai/core/util/path"
import type { useI18n } from "../../context/i18n"
import { getDirectory } from "./markdown-render"
import { toolInfoForInput } from "../tool-info"

export function contextToolDetail(part: ToolPart, i18n: ReturnType<typeof useI18n>): string | undefined {
  const info = toolInfoForInput(part.tool, part.state.input ?? {}, toolStateMetadata(part.state), i18n)
  if (info.subtitle) return info.subtitle
  if (part.state.status === "error") return toolStateError(part.state)
  if ((part.state.status === "running" || part.state.status === "completed") && part.state.title)
    return part.state.title
  const description = part.state.input?.description
  if (typeof description === "string") return description
  return undefined
}

export function contextToolTrigger(part: ToolPart, i18n: ReturnType<typeof useI18n>) {
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

export function contextToolSummary(parts: ToolPart[]) {
  const read = parts.filter((part) => part.tool === "read").length
  const search = parts.filter((part) => part.tool === "glob" || part.tool === "grep").length
  const list = parts.filter((part) => part.tool === "list").length
  return { read, search, list }
}
