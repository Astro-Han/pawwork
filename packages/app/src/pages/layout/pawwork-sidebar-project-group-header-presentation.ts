import type { IconName } from "@opencode-ai/ui/icon"

export type ProjectGroupHeaderKind = "project" | "direct-start"

export function projectGroupHeaderPresentation(input: { kind?: ProjectGroupHeaderKind; collapsed: boolean }): {
  icon: IconName
  canManage: boolean
} {
  if (input.kind === "direct-start") {
    return { icon: "bubble-5", canManage: false }
  }
  return { icon: input.collapsed ? "folder" : "folder-open", canManage: true }
}
