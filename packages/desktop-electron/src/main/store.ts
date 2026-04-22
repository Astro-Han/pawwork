import Store from "electron-store"

import { SETTINGS_STORE } from "./constants"

const cache = new Map<string, Store>()

export function getStore(name: string = SETTINGS_STORE) {
  const cached = cache.get(name)
  if (cached) return cached
  const next = new Store({ name, fileExtension: "" })
  cache.set(name, next)
  return next
}
