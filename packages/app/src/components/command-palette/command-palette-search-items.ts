import { createMemo, type Accessor } from "solid-js"
import type { CommandOption, useCommand } from "@/context/command"
import type { useFile } from "@/context/file"
import type { useGlobalSDK } from "@/context/global-sdk"
import type { useLanguage } from "@/context/language"
import { createSessionTabs } from "@/pages/session/helpers"
import type { CommandPaletteEntry } from "./command-palette-types"

const ENTRY_LIMIT = 5
const COMMON_COMMAND_IDS = [
  "session.new",
  "workspace.new",
  "session.previous",
  "session.next",
  "terminal.toggle",
  "review.toggle",
] as const

type SessionTabsAccessor = Accessor<{
  active: Accessor<string | undefined>
  all: Accessor<string[]>
}>

export const uniqueCommandPaletteEntries = (items: CommandPaletteEntry[]) => {
  const seen = new Set<string>()
  const out: CommandPaletteEntry[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

export const createCommandPaletteCommandEntry = (option: CommandOption, category: string): CommandPaletteEntry => ({
  id: "command:" + option.id,
  type: "command",
  title: option.title,
  description: option.description,
  keybind: option.keybind,
  category,
  option,
})

export const createCommandPaletteFileEntry = (path: string, category: string): CommandPaletteEntry => ({
  id: "file:" + path,
  type: "file",
  title: path,
  category,
  path,
})

export const createCommandPaletteSessionEntry = (
  input: {
    directory: string
    id: string
    title: string
    description: string
    archived?: number
    updated?: number
  },
  category: string,
): CommandPaletteEntry => ({
  id: `session:${input.directory}:${input.id}`,
  type: "session",
  title: input.title,
  description: input.description,
  category,
  directory: input.directory,
  sessionID: input.id,
  archived: input.archived,
  updated: input.updated,
})

export function createCommandPaletteCommandEntries(props: {
  filesOnly: () => boolean
  command: ReturnType<typeof useCommand>
  language: ReturnType<typeof useLanguage>
}) {
  const allowed = createMemo(() => {
    if (props.filesOnly()) return []
    return props.command.options.filter((option) => !option.disabled && !option.id.startsWith("suggested."))
  })

  const list = createMemo(() => {
    const category = props.language.t("palette.group.commands")
    return allowed().map((option) => createCommandPaletteCommandEntry(option, category))
  })

  const picks = createMemo(() => {
    const all = allowed()
    const order = new Map<string, number>(COMMON_COMMAND_IDS.map((id, index) => [id, index]))
    const picked = all.filter((option) => order.has(option.id))
    const base = picked.length ? picked : all.slice(0, ENTRY_LIMIT)
    const sorted = picked.length ? [...base].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)) : base
    const category = props.language.t("palette.group.commands")
    return sorted.map((option) => createCommandPaletteCommandEntry(option, category))
  })

  return { allowed, list, picks }
}

export function createCommandPaletteFileEntries(props: {
  file: ReturnType<typeof useFile>
  tabs: SessionTabsAccessor
  language: ReturnType<typeof useLanguage>
}) {
  const tabState = createSessionTabs({
    tabs: props.tabs,
    pathFromTab: props.file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? props.file.tab(tab) : tab),
  })
  const recent = createMemo(() => {
    const all = tabState.openedTabs()
    const active = tabState.activeFileTab()
    const order = active ? [active, ...all.filter((item) => item !== active)] : all
    const seen = new Set<string>()
    const category = props.language.t("palette.group.files")
    const items: CommandPaletteEntry[] = []

    for (const item of order) {
      const path = props.file.pathFromTab(item)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      items.push(createCommandPaletteFileEntry(path, category))
    }

    return items.slice(0, ENTRY_LIMIT)
  })

  const root = createMemo(() => {
    const category = props.language.t("palette.group.files")
    const nodes = props.file.tree.children("")
    const paths = nodes
      .filter((node) => node.type === "file")
      .map((node) => node.path)
      .sort((a, b) => a.localeCompare(b))
    return paths.slice(0, ENTRY_LIMIT).map((path) => createCommandPaletteFileEntry(path, category))
  })

  return { recent, root }
}

export function createCommandPaletteSessionEntries(props: {
  workspaces: () => string[]
  label: (directory: string) => string
  globalSDK: ReturnType<typeof useGlobalSDK>
  language: ReturnType<typeof useLanguage>
  pinnedIDs: () => string[]
}) {
  const state: {
    token: number
    cacheKey: string | undefined
    inflight: Promise<CommandPaletteEntry[]> | undefined
    cached: CommandPaletteEntry[] | undefined
  } = {
    token: 0,
    cacheKey: undefined,
    inflight: undefined,
    cached: undefined,
  }

  const sessions = (text: string) => {
    const query = text.trim()
    if (!query) return [] as CommandPaletteEntry[]

    const dirs = props.workspaces()
    if (dirs.length === 0) return [] as CommandPaletteEntry[]
    const cacheKey = JSON.stringify({
      dirs,
      pinned: props.pinnedIDs(),
    })

    if (state.cached && state.cacheKey === cacheKey) return state.cached
    if (state.inflight && state.cacheKey === cacheKey) return state.inflight

    const current = ++state.token
    state.cacheKey = cacheKey

    state.inflight = Promise.all(
      dirs.map((directory) => {
        const description = props.label(directory)
        return props.globalSDK.client.session
          .list({ directory, roots: true })
          .then((x) =>
            (x.data ?? [])
              .filter((s) => !!s?.id)
              .map((s) => ({
                id: s.id,
                title: s.title ?? props.language.t("command.session.new"),
                description,
                directory,
                archived: s.time?.archived,
                updated: s.time?.updated,
              })),
          )
          .catch(
            () =>
              [] as {
                id: string
                title: string
                description: string
                directory: string
                archived?: number
                updated?: number
              }[],
          )
      }),
    )
      .then((results) => {
        if (state.token !== current) return [] as CommandPaletteEntry[]
        const seen = new Set<string>()
        const category = props.language.t("command.category.session")
        const next = results
          .flat()
          .filter((item) => {
            const key = `${item.directory}:${item.id}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          .map((item) => createCommandPaletteSessionEntry(item, category))
        state.cached = next
        return next
      })
      .catch(() => [] as CommandPaletteEntry[])
      .finally(() => {
        if (state.token !== current) return
        state.inflight = undefined
      })

    return state.inflight
  }

  return { sessions }
}
