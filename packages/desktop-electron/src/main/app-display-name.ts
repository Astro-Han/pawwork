import type { MenuLocale } from "./menu-labels"

const zhNameMap = new Map([
  ["PawWork", "爪印"],
  ["PawWork Beta", "爪印 Beta"],
  ["PawWork Dev", "爪印 Dev"],
])

export function localizedAppDisplayName(appName: string, locale: MenuLocale) {
  if (locale !== "zh") return appName
  return zhNameMap.get(appName) ?? appName.replace(/^PawWork\b/, "爪印")
}
