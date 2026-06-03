// @ file popover + / command popover subsystem. Two useFilteredList
// instances, their select handlers, popover auto-scroll, and the
// promptProbe testing hook (gated behind promptEnabled()).

import { createEffect, createMemo, onCleanup, type Accessor, type Setter } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import { type ContentPart, type ImageAttachmentPart, type Prompt, type usePrompt } from "@/context/prompt"
import { DEFAULT_PROMPT } from "@/context/prompt-equality"
import type { useCommand } from "@/context/command"
import type { useSync } from "@/context/sync"
import type { useFile } from "@/context/file"
import type { useLanguage } from "@/context/language"
import { promptEnabled, promptProbe } from "@/testing/prompt"
import { type AtOption, type SlashCommand } from "./slash-popover"
import type { PromptStore } from "./store-types"
import { prependCommandMark } from "./command-prepend"

export interface PopoverControllersDeps {
  store: PromptStore
  setStore: SetStoreFunction<PromptStore>
  prompt: ReturnType<typeof usePrompt>
  command: ReturnType<typeof useCommand>
  sync: ReturnType<typeof useSync>
  files: ReturnType<typeof useFile>
  language: ReturnType<typeof useLanguage>
  recent: Accessor<string[]>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  actionReady: Accessor<boolean>
  // ref is nullable because PromptPopover assigns it on mount
  slashPopoverRef: () => HTMLDivElement | undefined
  addPart: (part: ContentPart) => boolean
  closePopover: () => void
  // editor imperatives subset (used by handleSlashSelect)
  clearEditor: () => void
  setEditorText: (text: string) => void
  focusEditorEnd: () => void
  // renderEditorWithCursor is needed to push pill DOM for custom commands
  renderEditorWithCursor: (parts: Prompt) => void
}

export interface PopoverControllers {
  atFlat: Accessor<AtOption[]>
  atActive: Accessor<string | null>
  setAtActive: Setter<string | null>
  atOnInput: (query: string) => void
  atOnKeyDown: (event: KeyboardEvent) => void
  atKey: (x: AtOption | undefined) => string
  handleAtSelect: (option: AtOption | undefined) => void
  slashFlat: Accessor<SlashCommand[]>
  slashActive: Accessor<string | null>
  setSlashActive: Setter<string | null>
  slashOnInput: (query: string) => void
  slashOnKeyDown: (event: KeyboardEvent) => void
  handleSlashSelect: (cmd: SlashCommand | undefined) => void
  selectPopoverActive: () => void
}

export function createPopoverControllers(deps: PopoverControllersDeps): PopoverControllers {
  const {
    store,
    prompt,
    command,
    sync,
    files,
    recent,
    imageAttachments,
    actionReady,
    slashPopoverRef,
    addPart,
    closePopover,
    clearEditor,
    setEditorText,
    focusEditorEnd,
    renderEditorWithCursor,
  } = deps

  const handleAtSelect = (option: AtOption | undefined) => {
    if (!actionReady()) return
    if (!option) return
    addPart({ type: "file", path: option.path, content: "@" + option.path, start: 0, end: 0 })
  }

  const atKey = (x: AtOption | undefined) => x?.path ?? ""

  const at = useFilteredList<AtOption>({
    items: async (query) => {
      const open = recent()
      const seen = new Set(open)
      const pinned: AtOption[] = open.map((path) => ({ type: "file", path, display: path, recent: true }))
      if (!query.trim()) return pinned
      const paths = await files.searchFilesAndDirectories(query)
      const fileOptions: AtOption[] = paths
        .filter((path) => !seen.has(path))
        .map((path) => ({ type: "file", path, display: path }))
      return [...pinned, ...fileOptions]
    },
    key: atKey,
    filterKeys: ["display"],
    groupBy: (item) => (item.recent ? "recent" : "file"),
    sortGroupsBy: (a, b) => (a.category === "recent" ? -1 : b.category === "recent" ? 1 : 0),
    onSelect: handleAtSelect,
  })

  const slashCommands = createMemo<SlashCommand[]>(() => {
    const builtin = command.options
      .filter((opt) => !opt.disabled && !opt.id.startsWith("suggested.") && opt.slash)
      .map((opt) => ({
        id: opt.id,
        trigger: opt.slash!,
        title: opt.title,
        description: opt.description,
        keybind: opt.keybind,
        type: "builtin" as const,
      }))

    const custom = sync.data.command.map((cmd) => ({
      // Source is part of the id so workspace + user configs that share a
      // command name don't collapse into one entry under useFilteredList.
      id: `custom.${cmd.source}.${cmd.name}`,
      trigger: cmd.name,
      title: cmd.name,
      description: cmd.description,
      type: "custom" as const,
      source: cmd.source,
    }))

    return [...custom, ...builtin]
  })

  const handleSlashSelect = (cmd: SlashCommand | undefined) => {
    if (!actionReady()) return
    if (!cmd) return
    promptProbe.select(cmd.id)
    closePopover()
    const images = imageAttachments()

    if (cmd.type === "custom") {
      // Build a marked TextPart (pill) and prepend it to the current prompt.
      // source is always present on custom commands (set in slashCommands memo).
      // icon is not stored on SlashCommand; default to "command" per spec.
      const descriptor = {
        name: cmd.trigger,
        source: cmd.source ?? "command",
        icon: "command",
      }
      const newPrompt = prependCommandMark(prompt.current(), images, descriptor)
      // prependCommandMark always places the marked TextPart at index 0.
      const markedPart = newPrompt[0] as import("@/context/prompt").TextPart
      prompt.set(newPrompt, markedPart.content.length)
      // Explicitly push pill DOM: prompt.set alone does not re-render the editor.
      renderEditorWithCursor(newPrompt)
      focusEditorEnd()
      return
    }

    clearEditor()
    prompt.set([...DEFAULT_PROMPT, ...images], 0)
    command.trigger(cmd.id, "slash")
  }

  const slash = useFilteredList<SlashCommand>({
    items: slashCommands,
    key: (x) => x?.id,
    filterKeys: ["trigger", "title"],
    onSelect: handleSlashSelect,
  })

  // Auto-scroll active command into view when navigating with keyboard
  createEffect(() => {
    const activeId = slash.active()
    const el = slashPopoverRef()
    if (!activeId || !el) return

    requestAnimationFrame(() => {
      const target = el.querySelector(`[data-slash-id="${activeId}"]`)
      target?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  })

  // Test-only probe — guard kept verbatim from the original main file so the
  // probe is never enabled in production builds.
  if (promptEnabled()) {
    createEffect(() => {
      promptProbe.set({
        popover: store.popover,
        slash: {
          active: slash.active() ?? null,
          ids: slash.flat().map((cmd) => cmd.id),
        },
      })
    })

    onCleanup(() => promptProbe.clear())
  }

  const selectPopoverActive = () => {
    if (store.popover === "at") {
      const items = at.flat()
      if (items.length === 0) return
      const active = at.active()
      const item = items.find((entry) => atKey(entry) === active) ?? items[0]
      handleAtSelect(item)
      return
    }

    if (store.popover === "slash") {
      const items = slash.flat()
      if (items.length === 0) return
      const active = slash.active()
      const item = items.find((entry) => entry.id === active) ?? items[0]
      handleSlashSelect(item)
    }
  }

  return {
    atFlat: at.flat,
    atActive: at.active,
    setAtActive: at.setActive,
    atOnInput: at.onInput,
    atOnKeyDown: at.onKeyDown,
    atKey,
    handleAtSelect,
    slashFlat: slash.flat,
    slashActive: slash.active,
    setSlashActive: slash.setActive,
    slashOnInput: slash.onInput,
    slashOnKeyDown: slash.onKeyDown,
    handleSlashSelect,
    selectPopoverActive,
  }
}
