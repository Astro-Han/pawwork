import { getStore } from "./store"
import { detectSystemMenuLocale, parseStoredMenuLocale, type MenuLocale } from "./menu-labels"

export function readStoredMenuLocale(systemLocale: string | null | undefined): MenuLocale {
  const raw = getStore("opencode.global.dat").get("language")
  const stored = parseStoredMenuLocale(raw)
  // Preserve an explicit user preference, including English; otherwise auto-detect from the OS locale.
  if (stored) return stored
  return detectSystemMenuLocale(systemLocale)
}

export function writeStoredMenuLocale(locale: MenuLocale) {
  // Legacy values used raw locale strings; current values wrap the locale in JSON.
  // parseStoredMenuLocale reads both formats for backward compatibility.
  getStore("opencode.global.dat").set("language", JSON.stringify({ locale }))
}
