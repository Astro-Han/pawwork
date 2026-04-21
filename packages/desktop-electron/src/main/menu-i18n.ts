import { getStore } from "./store"
import { detectSystemMenuLocale, parseMenuLocale, type MenuLocale } from "./menu-labels"

export function readStoredMenuLocale(systemLocale: string | null | undefined): MenuLocale {
  const raw = getStore("opencode.global.dat").get("language")
  const stored = parseMenuLocale(raw)
  // Keep an explicit stored locale, including English; otherwise detect from the OS locale.
  if (raw) return stored
  return detectSystemMenuLocale(systemLocale)
}

export function writeStoredMenuLocale(locale: MenuLocale) {
  getStore("opencode.global.dat").set("language", JSON.stringify({ locale }))
}
