import type { FileNode } from "@opencode-ai/sdk/v2"

type WatcherEvent = {
  type: string
  properties: unknown
}

type WatcherOps = {
  normalize: (input: string) => string
  hasFile: (path: string) => boolean
  isOpen?: (path: string) => boolean
  loadFile: (path: string) => void
  node: (path: string) => FileNode | undefined
  isDirLoaded: (path: string) => boolean
  loadedDirs?: () => string[]
  filesToReload?: () => string[]
  rootDirectory?: () => string
  refreshDir: (path: string) => void
}

function normalizedFilesystemPath(input: string) {
  const normalized = input.replace(/\\/g, "/").replace(/\/+$/, "")
  if (/^[A-Za-z]:/.test(normalized)) return normalized.toLowerCase()
  return normalized
}

export function invalidateFromWatcher(event: WatcherEvent, ops: WatcherOps) {
  if (event.type === "file.watcher.rescan") {
    const props =
      typeof event.properties === "object" && event.properties ? (event.properties as Record<string, unknown>) : undefined
    const directory = typeof props?.directory === "string" ? props.directory : undefined
    const root = ops.rootDirectory?.()
    if (directory && root && normalizedFilesystemPath(directory) !== normalizedFilesystemPath(root)) return

    const reloaded = new Set<string>()
    for (const rawFile of ops.filesToReload?.() ?? []) {
      const file = ops.normalize(rawFile)
      if (!file || file.startsWith(".git/")) continue
      if (reloaded.has(file)) continue
      if (!ops.hasFile(file) && !ops.isOpen?.(file)) continue
      reloaded.add(file)
      ops.loadFile(file)
    }

    for (const dir of ops.loadedDirs?.() ?? [""]) {
      if (!ops.isDirLoaded(dir)) continue
      ops.refreshDir(dir)
    }
    return
  }
  if (event.type !== "file.watcher.updated") return
  const props =
    typeof event.properties === "object" && event.properties ? (event.properties as Record<string, unknown>) : undefined
  const rawPath = typeof props?.file === "string" ? props.file : undefined
  const kind = typeof props?.event === "string" ? props.event : undefined
  if (!rawPath) return
  if (!kind) return

  const path = ops.normalize(rawPath)
  if (!path) return
  if (path.startsWith(".git/")) return

  if (ops.hasFile(path) || ops.isOpen?.(path)) {
    ops.loadFile(path)
  }

  if (kind === "change") {
    const dir = (() => {
      if (path === "") return ""
      const node = ops.node(path)
      if (node?.type !== "directory") return
      return path
    })()
    if (dir === undefined) return
    if (!ops.isDirLoaded(dir)) return
    ops.refreshDir(dir)
    return
  }
  if (kind !== "add" && kind !== "unlink") return

  const parent = path.split("/").slice(0, -1).join("/")
  if (!ops.isDirLoaded(parent)) return

  ops.refreshDir(parent)
}
