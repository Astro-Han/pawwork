export type WorktreeInfo = {
  name: string
  branch: string
  directory: string
  ownerDirectory: string
  source?: "created" | "existing"
}

export type BoundSession = {
  id: string
  title: string
  hostDirectory: string
}

export function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "")
  const last = trimmed.split(/[/\\]/).pop()
  return last || p
}

export function entryDirectory(entry: string | { directory: string }) {
  return typeof entry === "string" ? entry : entry.directory
}

export function errorText(error: unknown) {
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  try {
    const json = JSON.stringify(error)
    if (json && json !== "{}") return json
    return String(error)
  } catch {
    return String(error)
  }
}

export function sourceKey(source: WorktreeInfo["source"]) {
  return source === "existing" ? "settings.worktrees.source.existing" : "settings.worktrees.source.created"
}
