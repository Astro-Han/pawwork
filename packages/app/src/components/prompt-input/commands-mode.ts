// Owns the prompt-input file-pick action, mode switch, and command registration.
// Extracted from prompt-input.tsx. The factory must be called synchronously inside
// the component owner so command.register's onCleanup is scoped correctly.

import type { Accessor } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import { canUseNativeFilePicker, type usePlatform } from "@/context/platform"
import type { useCommand } from "@/context/command"
import type { useLanguage } from "@/context/language"
import { pickAttachments } from "./pick-attachments"
import type { PromptStore } from "./store-types"

export interface PromptCommandsAndModeDeps {
  command: ReturnType<typeof useCommand>
  language: ReturnType<typeof useLanguage>
  platform: ReturnType<typeof usePlatform>
  store: PromptStore
  setStore: SetStoreFunction<PromptStore>
  actionReady: Accessor<boolean>
  // Late-bound: addPickedPaths is produced by createPromptAttachments after this
  // factory is constructed, so it is injected as an accessor resolved at call time.
  addPickedPaths: () => (paths: string[]) => Promise<boolean>
  editorRef: () => HTMLDivElement | undefined
  fallbackInputClick: () => void
}

export interface PromptCommandsAndMode {
  pick: () => void
}

export function createPromptCommandsAndMode(deps: PromptCommandsAndModeDeps): PromptCommandsAndMode {
  const { command, language, platform, store, setStore, actionReady, addPickedPaths, editorRef, fallbackInputClick } =
    deps

  const pick = () => {
    if (!actionReady()) return
    const openFilePickerDialog = platform.openFilePickerDialog
    void pickAttachments({
      openFilePickerDialog: canUseNativeFilePicker(platform) ? openFilePickerDialog : undefined,
      addPickedPaths: addPickedPaths(),
      fallbackInputClick,
      isReady: actionReady,
    })
  }

  const setMode = (mode: "normal" | "shell") => {
    if (!actionReady()) return
    setStore("mode", mode)
    setStore("popover", null)
    requestAnimationFrame(() => editorRef()?.focus())
  }

  const shellModeKey = "mod+shift+x"
  const normalModeKey = "mod+shift+e"

  command.register("prompt-input", () => [
    {
      id: "file.attach",
      title: language.t("prompt.action.attachFile"),
      category: language.t("command.category.file"),
      keybind: "mod+u",
      disabled: store.mode !== "normal" || !actionReady(),
      onSelect: pick,
    },
    {
      id: "prompt.mode.shell",
      title: language.t("command.prompt.mode.shell"),
      category: language.t("command.category.session"),
      keybind: shellModeKey,
      disabled: store.mode === "shell" || !actionReady(),
      onSelect: () => setMode("shell"),
    },
    {
      id: "prompt.mode.normal",
      title: language.t("command.prompt.mode.normal"),
      category: language.t("command.category.session"),
      keybind: normalModeKey,
      disabled: store.mode === "normal" || !actionReady(),
      onSelect: () => setMode("normal"),
    },
  ])

  return { pick }
}
