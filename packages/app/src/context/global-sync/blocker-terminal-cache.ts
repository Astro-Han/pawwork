export type BlockerKind = "question" | "permission"

type Entry = {
  directory: string
  createdAt: number
}

const DEFAULT_MAX = 2048
const DEFAULT_TTL_MS = 5 * 60 * 1000

export function createBlockerTerminalCache(input?: { max?: number; ttlMs?: number; now?: () => number }) {
  const max = input?.max ?? DEFAULT_MAX
  const ttlMs = input?.ttlMs ?? DEFAULT_TTL_MS
  const now = input?.now ?? Date.now
  const entries = new Map<string, Entry>()

  const keyFor = (kind: BlockerKind, directory: string, sessionID: string, requestID: string) =>
    JSON.stringify([kind, directory, sessionID, requestID])

  const prune = () => {
    const cutoff = now() - ttlMs
    for (const [key, entry] of entries) {
      if (entry.createdAt >= cutoff) continue
      entries.delete(key)
    }
    while (entries.size > max) {
      const oldest = entries.keys().next().value
      if (!oldest) break
      entries.delete(oldest)
    }
  }

  return {
    mark(kind: BlockerKind, directory: string, sessionID: string, requestID: string) {
      const key = keyFor(kind, directory, sessionID, requestID)
      entries.delete(key)
      entries.set(key, { directory, createdAt: now() })
      prune()
    },
    has(kind: BlockerKind, directory: string, sessionID: string, requestID: string) {
      prune()
      return entries.has(keyFor(kind, directory, sessionID, requestID))
    },
    clearDirectory(directory: string) {
      for (const [key, entry] of entries) {
        if (entry.directory === directory) entries.delete(key)
      }
    },
  }
}
