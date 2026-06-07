import type { CommandOption } from "@/context/command"
import type { CommandPaletteEntry } from "./command-palette-types"

export type CommandPaletteDefaultGroupID = "suggested" | "navigation" | "panels" | "configure"

export type CommandPaletteDefaultLabels = Record<CommandPaletteDefaultGroupID, string>

type CommandPaletteDefaultGroup = {
  id: CommandPaletteDefaultGroupID
  commandIDs: readonly string[]
}

type BuildCommandPaletteDefaultGroupsInput = {
  options: CommandOption[]
  labels: CommandPaletteDefaultLabels
}

export type CommandPaletteDefaultGroupResult = {
  id: CommandPaletteDefaultGroupID
  label: string
  items: CommandPaletteEntry[]
}

const SUGGESTED_PREFIX = "suggested."

const DEFAULT_GROUPS: readonly CommandPaletteDefaultGroup[] = [
  { id: "suggested", commandIDs: ["session.new", "project.open", "file.open", "settings.open"] },
  { id: "navigation", commandIDs: ["session.previous", "session.next", "input.focus"] },
  { id: "panels", commandIDs: ["sidebar.toggle", "panel.toggle", "terminal.toggle", "review.toggle", "browser.toggle"] },
  { id: "configure", commandIDs: ["model.choose", "mcp.toggle", "permissions.autoaccept"] },
]

function commandEntry(option: CommandOption, category: string): CommandPaletteEntry {
  return {
    id: "command:" + option.id,
    type: "command",
    title: option.title,
    description: option.description,
    keybind: option.keybind,
    category,
    option,
  }
}

export function buildCommandPaletteDefaultGroups({
  options,
  labels,
}: BuildCommandPaletteDefaultGroupsInput): CommandPaletteDefaultGroupResult[] {
  const optionsByID = new Map(
    options.filter((option) => !option.disabled && !option.id.startsWith(SUGGESTED_PREFIX)).map((option) => [option.id, option]),
  )

  return DEFAULT_GROUPS.map((group) => {
    const label = labels[group.id]
    return {
      id: group.id,
      label,
      items: group.commandIDs.flatMap((id) => {
        const option = optionsByID.get(id)
        return option ? [commandEntry(option, label)] : []
      }),
    }
  }).filter((group) => group.items.length > 0)
}
