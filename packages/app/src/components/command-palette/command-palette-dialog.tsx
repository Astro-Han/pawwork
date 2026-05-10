import { CommandPalette } from "@opencode-ai/ui/command-palette"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { List } from "@opencode-ai/ui/list"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { useNavigate } from "@solidjs/router"
import { createMemo, createSignal, onCleanup } from "solid-js"
import { useCommand } from "@/context/command"
import { useFile } from "@/context/file"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLayoutPage } from "@/context/layout-page"
import { pawworkSessionDirectories } from "@/pages/layout/pawwork-session-source"
import { useSessionLayout } from "@/pages/session/session-layout"
import { decode64 } from "@/utils/base64"
import { buildCommandPaletteDefaultGroups } from "./command-palette-default-items"
import { CommandPaletteRow } from "./command-palette-row"
import {
  createCommandPaletteCommandEntries,
  createCommandPaletteFileEntries,
  createCommandPaletteFileEntry,
  createCommandPaletteSessionEntries,
  uniqueCommandPaletteEntries,
} from "./command-palette-search-items"
import type { CommandPaletteEntry, DialogSelectFileMode } from "./command-palette-types"

export function DialogSelectFile(props: { mode?: DialogSelectFileMode; onOpenFile?: (path: string) => void }) {
  const command = useCommand()
  const language = useLanguage()
  const layout = useLayout()
  const file = useFile()
  const dialog = useDialog()
  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const layoutPage = useLayoutPage()
  const { params, tabs, view } = useSessionLayout()
  const filesOnly = () => props.mode === "files"
  const state = { cleanup: undefined as (() => void) | void, committed: false }
  const [grouped, setGrouped] = createSignal(false)
  const commandEntries = createCommandPaletteCommandEntries({ filesOnly, command, language })
  const fileEntries = createCommandPaletteFileEntries({ file, tabs, language })
  const pinnedSet = createMemo(() => new Set(layoutPage.pinnedIDs()))
  const defaultGroups = createMemo(() =>
    buildCommandPaletteDefaultGroups({
      options: command.options,
      labels: {
        suggested: language.t("palette.group.suggested"),
        navigation: language.t("palette.group.navigation"),
        panels: language.t("palette.group.panels"),
        configure: language.t("palette.group.configure"),
      },
    }),
  )
  const projectDirectory = createMemo(() => decode64(params.dir) ?? "")
  const project = createMemo(() => {
    const directory = projectDirectory()
    if (!directory) return
    return layout.projects.list().find((p) => p.worktree === directory || p.sandboxes?.includes(directory))
  })
  const workspaces = createMemo(() => {
    const directory = projectDirectory()
    const current = project()
    if (!current) return directory ? [directory] : []
    return pawworkSessionDirectories({
      project: current,
      activeProjectWorktree: current.worktree,
      currentDirectory: directory,
      workspaceOrder: layoutPage.workspaceOrderFor(current.worktree),
    })
  })
  const homedir = createMemo(() => globalSync.data.path.home)
  const label = (directory: string) => {
    const current = project()
    const kind =
      current && directory === current.worktree
        ? language.t("workspace.type.local")
        : language.t("workspace.type.sandbox")
    const [store] = globalSync.child(directory, { bootstrap: false })
    const home = homedir()
    const path = home ? directory.replace(home, "~") : directory
    const name = store.vcs?.branch ?? getFilename(directory)
    return `${kind} : ${name || path}`
  }

  const { sessions } = createCommandPaletteSessionEntries({
    workspaces,
    label,
    globalSDK,
    language,
    pinnedIDs: layoutPage.pinnedIDs,
  })

  const defaultItems = createMemo(() =>
    defaultGroups().flatMap((group) =>
      group.items.map((item) => ({
        ...item,
        category: group.label,
      })),
    ),
  )

  const items = async (text: string) => {
    const query = text.trim()
    setGrouped(filesOnly() ? query.length > 0 : true)

    if (!query && filesOnly()) {
      const loaded = file.tree.state("")?.loaded
      const pending = loaded ? Promise.resolve() : file.tree.list("")
      const next = uniqueCommandPaletteEntries([...fileEntries.recent(), ...fileEntries.root()])

      if (loaded || next.length > 0) {
        void pending
        return next
      }

      await pending
      return uniqueCommandPaletteEntries([...fileEntries.recent(), ...fileEntries.root()])
    }

    if (!query) return defaultItems()

    if (filesOnly()) {
      const files = await file.searchFiles(query)
      const category = language.t("palette.group.files")
      return files.map((path) => createCommandPaletteFileEntry(path, category))
    }

    const [files, nextSessions] = await Promise.all([file.searchFiles(query), Promise.resolve(sessions(query))])
    const category = language.t("palette.group.files")
    const entries = files.map((path) => createCommandPaletteFileEntry(path, category))
    return [...commandEntries.list(), ...nextSessions, ...entries]
  }

  const handleMove = (item: CommandPaletteEntry | undefined) => {
    state.cleanup?.()
    if (!item) return
    if (item.type !== "command") return
    state.cleanup = item.option?.onHighlight?.()
  }

  const open = (path: string) => {
    const value = file.tab(path)
    tabs().open(value)
    file.load(path)
    view().sidePanel.openTab("review")
    view().sidePanel.explorer.setTab("all")
    props.onOpenFile?.(path)
    tabs().setActive(value)
  }

  const openFileOnlyPicker = () => {
    dialog.show(() => <DialogSelectFile mode="files" onOpenFile={props.onOpenFile} />)
  }

  const handleSelect = (item: CommandPaletteEntry | undefined) => {
    if (!item) return
    state.committed = true
    state.cleanup = undefined
    dialog.close()

    if (item.type === "command") {
      if (item.option?.id === "file.open" && !filesOnly()) {
        openFileOnlyPicker()
        return
      }

      item.option?.onSelect?.("palette")
      return
    }

    if (item.type === "session") {
      if (!item.directory || !item.sessionID) return
      navigate(`/${base64Encode(item.directory)}/session/${item.sessionID}`)
      return
    }

    if (!item.path) return
    open(item.path)
  }

  onCleanup(() => {
    if (state.committed) return
    state.cleanup?.()
  })

  return (
    <CommandPalette transition label={language.t("palette.aria.label")}>
      <List
        search={{
          placeholder: filesOnly() ? language.t("session.header.searchFiles") : language.t("palette.search.placeholder"),
          autofocus: true,
        }}
        emptyMessage={language.t("palette.empty")}
        loadingMessage={language.t("common.loading")}
        items={items}
        key={(item) => item.id}
        filterKeys={["title", "description", "category"]}
        sortBy={(a, b) => {
          if (!filesOnly() && !grouped()) return 0
          if (a.type !== "session" || b.type !== "session") return 0
          const aPinned = !!a.sessionID && pinnedSet().has(a.sessionID)
          const bPinned = !!b.sessionID && pinnedSet().has(b.sessionID)
          if (aPinned !== bPinned) return aPinned ? -1 : 1
          return (b.updated ?? 0) - (a.updated ?? 0) || a.title.localeCompare(b.title)
        }}
        groupBy={grouped() ? (item) => item.category : () => ""}
        onMove={handleMove}
        onSelect={handleSelect}
      >
        {(item) => <CommandPaletteRow item={item} />}
      </List>
    </CommandPalette>
  )
}
