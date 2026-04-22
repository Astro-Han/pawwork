import { join } from "node:path"

export const PAWWORK_RUNTIME = {
  client: "desktop",
  serverUsername: "PawWork",
  settingsStore: "pawwork.settings",
  databaseName: "pawwork.db",
} as const

export function runtimeRoots(userData: string) {
  return {
    data: join(userData, "data"),
    cache: join(userData, "cache"),
    config: join(userData, "config"),
    state: join(userData, "state"),
  }
}

export function databasePathForUserData(userData: string) {
  return join(runtimeRoots(userData).data, "pawwork", PAWWORK_RUNTIME.databaseName)
}
