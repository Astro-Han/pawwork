import type { CommandOption } from "@/context/command"

export type CommandPaletteEntryType = "command" | "file" | "session"

export type CommandPaletteEntry = {
  id: string
  type: CommandPaletteEntryType
  title: string
  description?: string
  keybind?: string
  category: string
  option?: CommandOption
  path?: string
  directory?: string
  sessionID?: string
  archived?: number
  updated?: number
}

export type DialogSelectFileMode = "all" | "files"
