import { createEffect, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createSimpleContext } from "../context/helper"
import pawworkThemeJson from "./themes/pawwork.json"
import { resolveThemeVariant, themeToCss } from "./resolve"
import type { DesktopTheme } from "./types"

export type ColorScheme = "light" | "dark" | "system"

export type ThemeStorageKeys = {
  themeId: string
  colorScheme: string
  cssLight: string
  cssDark: string
}

const DEFAULT_STORAGE_KEYS: ThemeStorageKeys = {
  themeId: "opencode-theme-id",
  colorScheme: "opencode-color-scheme",
  cssLight: "opencode-theme-css-light",
  cssDark: "opencode-theme-css-dark",
} as const

const THEME_STYLE_ID = "oc-theme"
const DEFAULT_THEME_ID = "pawwork"
let files: Record<string, () => Promise<{ default: DesktopTheme }>> | undefined
let ids: string[] | undefined
let known: Set<string> | undefined

function getFiles() {
  if (files) return files
  files = import.meta.glob<{ default: DesktopTheme }>("./themes/*.json")
  return files
}

function themeIDs() {
  if (ids) return ids
  ids = Object.keys(getFiles())
    .map((path) => path.slice("./themes/".length, -".json".length))
    .sort()
  return ids
}

function knownThemes() {
  if (known) return known
  known = new Set(themeIDs())
  return known
}

const names: Record<string, string> = {
  pawwork: "PawWork",
}
const pawworkTheme = pawworkThemeJson as DesktopTheme

function read(key: string) {
  if (typeof localStorage !== "object") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.setItem(key, value)
  } catch {}
}

function drop(key: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.removeItem(key)
  } catch {}
}

function clear(keys: ThemeStorageKeys) {
  drop(keys.cssLight)
  drop(keys.cssDark)
}

function ensureThemeStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
  if (existing) return existing
  const element = document.createElement("style")
  element.id = THEME_STYLE_ID
  document.head.appendChild(element)
  return element
}

function getSystemMode(): "light" | "dark" {
  if (typeof window !== "object") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function resolveMode(_themeId: string, colorScheme: ColorScheme): "light" | "dark" {
  return colorScheme === "system" ? getSystemMode() : colorScheme
}

function applyThemeCss(theme: DesktopTheme, themeId: string, mode: "light" | "dark", keys: ThemeStorageKeys) {
  const isDark = mode === "dark"
  const variant = isDark ? theme.dark : theme.light
  const tokens = resolveThemeVariant(variant, isDark)
  const css = themeToCss(tokens)

  write(isDark ? keys.cssDark : keys.cssLight, css)

  const fullCss = `:root {
  color-scheme: ${mode};
  --text-mix-blend-mode: ${isDark ? "plus-lighter" : "multiply"};
  ${css}
}`

  document.getElementById("oc-theme-preload")?.remove()
  ensureThemeStyleElement().textContent = fullCss
  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
}

function cacheThemeVariants(theme: DesktopTheme, _themeId: string, keys: ThemeStorageKeys) {
  for (const mode of ["light", "dark"] as const) {
    const isDark = mode === "dark"
    const variant = isDark ? theme.dark : theme.light
    const tokens = resolveThemeVariant(variant, isDark)
    const css = themeToCss(tokens)
    write(isDark ? keys.cssDark : keys.cssLight, css)
  }
}

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: (props: {
    defaultTheme?: string
    storageKeys?: Partial<ThemeStorageKeys>
    onThemeApplied?: (theme: DesktopTheme, mode: "light" | "dark") => void
  }) => {
    const storageKeys = { ...DEFAULT_STORAGE_KEYS, ...props.storageKeys }
    const rawStoredTheme = read(storageKeys.themeId)
    const storedTheme = rawStoredTheme && knownThemes().has(rawStoredTheme) ? rawStoredTheme : null
    const storedScheme = read(storageKeys.colorScheme) as ColorScheme | null
    const firstInstall = !rawStoredTheme && !storedScheme
    const fallbackDefault =
      props.defaultTheme && knownThemes().has(props.defaultTheme) ? props.defaultTheme : DEFAULT_THEME_ID
    const themeId = storedTheme ?? fallbackDefault
    const colorScheme = (storedScheme ?? (firstInstall ? "light" : "system")) as ColorScheme
    const mode = resolveMode(themeId, colorScheme)
    const [store, setStore] = createStore({
      themes: {
        [DEFAULT_THEME_ID]: pawworkTheme,
      } as Record<string, DesktopTheme>,
      themeId,
      colorScheme,
      mode,
      previewThemeId: null as string | null,
      previewScheme: null as ColorScheme | null,
    })

    const loads = new Map<string, Promise<DesktopTheme | undefined>>()

    const load = (id: string) => {
      if (!id) return Promise.resolve(undefined)
      const hit = store.themes[id]
      if (hit) return Promise.resolve(hit)
      const pending = loads.get(id)
      if (pending) return pending
      const file = getFiles()[`./themes/${id}.json`]
      if (!file) return Promise.resolve(undefined)
      const task = file()
        .then((mod) => {
          const theme = mod.default
          setStore("themes", id, theme)
          return theme
        })
        .finally(() => {
          loads.delete(id)
        })
      loads.set(id, task)
      return task
    }

    const applyTheme = (theme: DesktopTheme, themeId: string, mode: "light" | "dark") => {
      applyThemeCss(theme, themeId, mode, storageKeys)
      props.onThemeApplied?.(theme, mode)
    }

    const ids = () => {
      const extra = Object.keys(store.themes)
        .filter((id) => !knownThemes().has(id))
        .sort()
      const all = themeIDs()
      if (extra.length === 0) return all
      return [...all, ...extra]
    }

    const loadThemes = () => Promise.all(themeIDs().map(load)).then(() => store.themes)

    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKeys.themeId && e.newValue) {
        const next = e.newValue
        if (!knownThemes().has(next) && !store.themes[next]) return
        setStore("themeId", next)
        void load(next).then((theme) => {
          if (!theme || store.themeId !== next) return
          cacheThemeVariants(theme, next, storageKeys)
        })
      }
      if (e.key === storageKeys.colorScheme && e.newValue) {
        const nextScheme = e.newValue as ColorScheme
        setStore("colorScheme", nextScheme)
        setStore("mode", resolveMode(store.themeId, nextScheme))
      }
    }

    onMount(() => {
      makeEventListener(window, "storage", onStorage)

      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
      const onMedia = () => {
        if (store.colorScheme !== "system") return
        setStore("mode", getSystemMode())
      }
      makeEventListener(mediaQuery, "change", onMedia)

      const rawTheme = read(storageKeys.themeId)
      const rawScheme = read(storageKeys.colorScheme) as ColorScheme | null
      const firstInstall = !rawTheme && !rawScheme
      const candidate = rawTheme ?? props.defaultTheme
      const savedTheme = candidate && knownThemes().has(candidate) ? candidate : DEFAULT_THEME_ID
      const savedScheme = (rawScheme ?? (firstInstall ? "light" : "system")) as ColorScheme
      if (rawTheme && rawTheme !== savedTheme) {
        write(storageKeys.themeId, savedTheme)
        clear(storageKeys)
      }
      if (savedTheme !== store.themeId) setStore("themeId", savedTheme)
      if (savedScheme !== store.colorScheme) setStore("colorScheme", savedScheme)
      setStore("mode", resolveMode(savedTheme, savedScheme))
      void load(savedTheme).then((theme) => {
        if (!theme || store.themeId !== savedTheme) return
        cacheThemeVariants(theme, savedTheme, storageKeys)
      })
    })

    createEffect(() => {
      const theme = store.themes[store.themeId]
      if (!theme) return
      applyTheme(theme, store.themeId, store.mode)
    })

    const setTheme = (id: string) => {
      if (!knownThemes().has(id) && !store.themes[id]) {
        console.warn(`Theme "${id}" not found`)
        return
      }
      setStore("themeId", id)
      void load(id).then((theme) => {
        if (!theme || store.themeId !== id) return
        cacheThemeVariants(theme, id, storageKeys)
        write(storageKeys.themeId, id)
      })
    }

    const setColorScheme = (scheme: ColorScheme) => {
      setStore("colorScheme", scheme)
      write(storageKeys.colorScheme, scheme)
      setStore("mode", resolveMode(store.themeId, scheme))
    }

    return {
      themeId: () => store.themeId,
      colorScheme: () => store.colorScheme,
      mode: () => store.mode,
      ids,
      name: (id: string) => store.themes[id]?.name ?? names[id] ?? id,
      loadThemes,
      themes: () => store.themes,
      canSwitchColorScheme: () => true,
      setTheme,
      setColorScheme,
      registerTheme: (theme: DesktopTheme) => setStore("themes", theme.id, theme),
      previewTheme: (id: string) => {
        if (!knownThemes().has(id) && !store.themes[id]) return
        setStore("previewThemeId", id)
        void load(id).then((theme) => {
          if (!theme || store.previewThemeId !== id) return
          const mode = store.previewScheme ? resolveMode(id, store.previewScheme) : store.mode
          applyTheme(theme, id, mode)
        })
      },
      previewColorScheme: (scheme: ColorScheme) => {
        setStore("previewScheme", scheme)
        const id = store.previewThemeId ?? store.themeId
        void load(id).then((theme) => {
          if (!theme) return
          if ((store.previewThemeId ?? store.themeId) !== id) return
          if (store.previewScheme !== scheme) return
          applyTheme(theme, id, resolveMode(id, scheme))
        })
      },
      commitPreview: () => {
        if (store.previewThemeId) {
          setTheme(store.previewThemeId)
        }
        if (store.previewScheme) {
          setColorScheme(store.previewScheme)
        }
        setStore("previewThemeId", null)
        setStore("previewScheme", null)
      },
      cancelPreview: () => {
        setStore("previewThemeId", null)
        setStore("previewScheme", null)
        void load(store.themeId).then((theme) => {
          if (!theme) return
          applyTheme(theme, store.themeId, store.mode)
        })
      },
    }
  },
})
