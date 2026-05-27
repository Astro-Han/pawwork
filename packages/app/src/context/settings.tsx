import { createStore, reconcile } from "solid-js/store"
import { createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { persisted } from "@/utils/persist"

export type NotifyLevel = "never" | "unfocused" | "always"

export interface Settings {
  general: {
    autoSave: boolean
    releaseNotes: boolean
    followup: "queue" | "steer"
    showFileTree: boolean
    showNavigation: boolean
    showSearch: boolean
    showStatus: boolean
    showTerminal: boolean
    lspEnabled: boolean
    webSearchEnabled: boolean
    homeSuggestionsDismissed: string[]
  }
  updates: {
    startup: boolean
  }
  appearance: {
    fontSize: number
    mono: string
    sans: string
  }
  keybinds: Record<string, string>
  notify: NotifyLevel
}

export const monoDefault = "System Mono"
export const sansDefault = "System Sans"

const monoFallback =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
const sansFallback = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const pawworkSansFallback = "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"

const monoBase = monoFallback
const sansBase = sansFallback

function input(font: string | undefined) {
  return font ?? ""
}

function family(font: string) {
  if (/^[\w-]+$/.test(font)) return font
  return `"${font.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function stack(font: string | undefined, base: string) {
  const value = font?.trim() ?? ""
  if (!value) return base
  return `${family(value)}, ${base}`
}

export function monoInput(font: string | undefined) {
  return input(font)
}

export function sansInput(font: string | undefined) {
  return input(font)
}

export function monoFontFamily(font: string | undefined) {
  return stack(font, monoBase)
}

export function sansFontFamily(font: string | undefined) {
  return stack(font, sansBase)
}

export function resolveSansFontFamily(input: { themeID?: string; font?: string }) {
  const font = input.font?.trim()
  if (font) return sansFontFamily(font)
  if (input.themeID === "pawwork") return pawworkSansFallback
  return sansFontFamily(undefined)
}

const defaultSettings: Settings = {
  general: {
    autoSave: true,
    releaseNotes: true,
    followup: "queue",
    showFileTree: false,
    showNavigation: false,
    showSearch: false,
    showStatus: false,
    showTerminal: false,
    lspEnabled: false,
    webSearchEnabled: true,
    homeSuggestionsDismissed: [],
  },
  updates: {
    startup: true,
  },
  appearance: {
    fontSize: 14,
    mono: "",
    sans: "",
  },
  keybinds: {},
  notify: "unfocused" as NotifyLevel,
}

function withFallback<T>(read: () => T | undefined, fallback: T) {
  return createMemo(() => read() ?? fallback)
}

const VALID_NOTIFY_LEVELS = new Set<string>(["never", "unfocused", "always"])

export const { use: useSettings, provider: SettingsProvider } = createSimpleContext({
  name: "Settings",
  init: () => {
    // Clone so the store never mutates the shared defaultSettings constant in
    // place; the fallback accessors below read defaultSettings.* as their source
    // of truth, and a stale persisted value reconciled into the store would
    // otherwise overwrite those defaults (e.g. withSoundFallback would "fall
    // back" to the very invalid id it was meant to replace).
    const [store, setStore, _, ready] = persisted("settings.v3", createStore<Settings>(structuredClone(defaultSettings)))
    const [themeID, setThemeID] = createSignal<string | undefined>()

    onMount(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement
      const syncTheme = () => setThemeID(root.dataset.theme)
      syncTheme()
      const observer = new MutationObserver(syncTheme)
      observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] })
      onCleanup(() => observer.disconnect())
    })

    createEffect(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement
      root.style.setProperty("--font-family-mono", monoFontFamily(store.appearance?.mono))
      root.style.setProperty(
        "--font-family-sans",
        resolveSansFontFamily({
          themeID: themeID(),
          font: store.appearance?.sans,
        }),
      )
    })

    createEffect(() => {
      if (!ready()) return
      untrack(() => {
        const rawStore = store as unknown as Record<string, unknown>
        if (VALID_NOTIFY_LEVELS.has(rawStore["notify"] as string)) return
        const sounds = rawStore["sounds"] as Record<string, unknown> | undefined
        const notifications = rawStore["notifications"] as Record<string, unknown> | undefined
        const allDisabled =
          sounds?.agentEnabled === false &&
          sounds?.permissionsEnabled === false &&
          sounds?.errorsEnabled === false &&
          notifications?.agent === false &&
          notifications?.permissions === false &&
          notifications?.errors === false
        const level: NotifyLevel = allDisabled ? "never" : "unfocused"
        const setRaw = setStore as unknown as (key: string, value: unknown) => void
        setRaw("notify", level)
        setRaw("notifications", undefined)
        setRaw("sounds", undefined)
      })
    })

    // PawWork wants followup to always queue: submit during a busy session
    // enters the followup dock; "send now" steers mid-stream; otherwise
    // auto-send when the current turn ends. The "steer" mode (immediate
    // submit during busy with no queue UI) is upstream-only and not
    // surfaced by any PawWork settings UI, so any stored "steer" is a
    // migration artifact from before this flip.
    createEffect(() => {
      if (!ready()) return
      if (store.general?.followup !== "steer") return
      setStore("general", "followup", "queue")
    })

    // Mirror lspEnabled into the Electron main process. Fires on store
    // rehydration (restart sync) and on every toggle. On IPC rejection,
    // rolls the store back so the UI reflects the actual runtime state.
    createEffect(() => {
      if (!ready()) return
      const value = store.general?.lspEnabled ?? defaultSettings.general.lspEnabled
      void window.api?.setLspEnabled?.(value)?.catch(() => {
        const current = store.general?.lspEnabled ?? defaultSettings.general.lspEnabled
        if (current !== value) return
        setStore("general", "lspEnabled", !value)
      })
    })

    let rollingBackWebSearchEnabled = false
    createEffect(() => {
      if (!ready()) return
      const value = store.general?.webSearchEnabled ?? defaultSettings.general.webSearchEnabled
      if (rollingBackWebSearchEnabled) {
        rollingBackWebSearchEnabled = false
        return
      }
      void window.api?.setWebSearchEnabled?.(value)?.catch(() => {
        const current = store.general?.webSearchEnabled ?? defaultSettings.general.webSearchEnabled
        if (current !== value) return
        rollingBackWebSearchEnabled = true
        setStore("general", "webSearchEnabled", !value)
      })
    })

    return {
      ready,
      get current() {
        return store
      },
      general: {
        autoSave: withFallback(() => store.general?.autoSave, defaultSettings.general.autoSave),
        setAutoSave(value: boolean) {
          setStore("general", "autoSave", value)
        },
        releaseNotes: withFallback(() => store.general?.releaseNotes, defaultSettings.general.releaseNotes),
        setReleaseNotes(value: boolean) {
          setStore("general", "releaseNotes", value)
        },
        followup: withFallback(() => store.general?.followup, defaultSettings.general.followup),
        setFollowup(value: "queue" | "steer") {
          setStore("general", "followup", value)
        },
        showFileTree: withFallback(() => store.general?.showFileTree, defaultSettings.general.showFileTree),
        setShowFileTree(value: boolean) {
          setStore("general", "showFileTree", value)
        },
        showNavigation: withFallback(() => store.general?.showNavigation, defaultSettings.general.showNavigation),
        setShowNavigation(value: boolean) {
          setStore("general", "showNavigation", value)
        },
        showSearch: withFallback(() => store.general?.showSearch, defaultSettings.general.showSearch),
        setShowSearch(value: boolean) {
          setStore("general", "showSearch", value)
        },
        showStatus: withFallback(() => store.general?.showStatus, defaultSettings.general.showStatus),
        setShowStatus(value: boolean) {
          setStore("general", "showStatus", value)
        },
        showTerminal: withFallback(() => store.general?.showTerminal, defaultSettings.general.showTerminal),
        setShowTerminal(value: boolean) {
          setStore("general", "showTerminal", value)
        },
        lspEnabled: withFallback(() => store.general?.lspEnabled, defaultSettings.general.lspEnabled),
        setLspEnabled(value: boolean) {
          // The createEffect above mirrors this change to the Electron main
          // process and rolls back if the IPC handler rejects.
          setStore("general", "lspEnabled", value)
        },
        webSearchEnabled: withFallback(() => store.general?.webSearchEnabled, defaultSettings.general.webSearchEnabled),
        setWebSearchEnabled(value: boolean) {
          setStore("general", "webSearchEnabled", value)
        },
        homeSuggestionsDismissed: withFallback(
          () => store.general?.homeSuggestionsDismissed,
          defaultSettings.general.homeSuggestionsDismissed,
        ),
        setHomeSuggestionsDismissed(value: string[]) {
          setStore("general", "homeSuggestionsDismissed", value)
        },
      },
      updates: {
        startup: withFallback(() => store.updates?.startup, defaultSettings.updates.startup),
        setStartup(value: boolean) {
          setStore("updates", "startup", value)
        },
      },
      appearance: {
        fontSize: withFallback(() => store.appearance?.fontSize, defaultSettings.appearance.fontSize),
        setFontSize(value: number) {
          setStore("appearance", "fontSize", value)
        },
        font: withFallback(() => store.appearance?.mono, defaultSettings.appearance.mono),
        setFont(value: string) {
          setStore("appearance", "mono", value.trim() ? value : "")
        },
        uiFont: withFallback(() => store.appearance?.sans, defaultSettings.appearance.sans),
        setUIFont(value: string) {
          setStore("appearance", "sans", value.trim() ? value : "")
        },
      },
      keybinds: {
        get: (action: string) => store.keybinds?.[action],
        set(action: string, keybind: string) {
          setStore("keybinds", action, keybind)
        },
        reset(action: string) {
          setStore("keybinds", (current) => {
            if (!Object.prototype.hasOwnProperty.call(current, action)) return current
            const next = { ...current }
            delete next[action]
            return next
          })
        },
        resetAll() {
          setStore("keybinds", reconcile({}))
        },
      },
      notify: {
        level: withFallback(() => store.notify, defaultSettings.notify),
        setLevel(value: NotifyLevel) {
          setStore("notify", value)
        },
      },
    }
  },
})
