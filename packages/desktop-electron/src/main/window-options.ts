import { join } from "node:path"

export function rendererWebPreferences(root: string) {
  return {
    preload: join(root, "../preload/index.js"),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  }
}
