import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises"
import { dirname } from "node:path"

// Process-wide so two stores sharing a path (same pid) never collide on a temp
// name or rename over the same state file at the same time.
let tempSequence = 0
const writeQueues = new Map<string, Promise<void>>()

/**
 * Maps remote conversations (a platform-scoped key) to PawWork sessions and
 * tracks the SSE event cursor. With a non-empty path it persists to disk; an
 * empty/undefined path keeps everything in memory.
 *
 * Ported from the Go `bridge.SessionPointersStore`. JS runs the in-memory map
 * mutations on a single thread, so the explicit mutex is gone; disk writes for
 * the same path are still serialized and land atomically through a unique temp
 * file + rename, so an interrupted or interleaved write can never leave a
 * partial snapshot on disk.
 */
export class SessionPointers {
  private readonly path: string
  private sessions = new Map<string, string>()
  private parents = new Map<string, string>()
  private cursor = ""

  constructor(path = "") {
    this.path = path
  }

  static memory(): SessionPointers {
    return new SessionPointers("")
  }

  /** Load a persisted store, or start empty when the file is absent/blank. */
  static async fromFile(path: string): Promise<SessionPointers> {
    const store = new SessionPointers(path)
    let data: string
    try {
      data = await readFile(path, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return store
      throw err
    }
    if (data.trim() === "") return store
    const parsed = JSON.parse(data) as Record<string, unknown>
    const isWrapped = parsed.sessions !== undefined || parsed.parents !== undefined || parsed.eventCursor !== undefined
    if (isWrapped) {
      const state = parsed as { sessions?: Record<string, string>; parents?: Record<string, string>; eventCursor?: string }
      if (state.sessions) store.sessions = new Map(Object.entries(state.sessions))
      if (state.parents) store.parents = new Map(Object.entries(state.parents))
      store.cursor = state.eventCursor ?? ""
    } else {
      // Legacy bare-map format ({"<remoteKey>":"<sessionID>"}) written by an
      // early build. Match the Go loader's fallback so an upgrade keeps its
      // chat-to-session bindings instead of silently starting empty.
      store.sessions = new Map(Object.entries(parsed as Record<string, string>))
    }
    return store
  }

  get(remoteKey: string): string {
    return this.sessions.get(remoteKey) ?? ""
  }

  async set(remoteKey: string, sessionID: string): Promise<void> {
    if (hasRootConflict(this.sessions, this.parents, remoteKey, sessionID)) {
      throw new Error("session root is already bound to another remote conversation")
    }
    this.sessions.set(remoteKey, sessionID)
    await this.save()
  }

  async setParent(sessionID: string, parentID: string): Promise<void> {
    if (sessionID === "" || parentID === "") return
    if (parentChainReaches(this.parents, parentID, sessionID)) {
      throw new Error("session parent would create a cycle")
    }
    if (hasAnyRootConflict(this.sessions, withParent(this.parents, sessionID, parentID))) {
      throw new Error("session root is already bound to another remote conversation")
    }
    this.parents.set(sessionID, parentID)
    await this.save()
  }

  /** The remote key bound to a session's root, or "" when none or ambiguous. */
  remoteKeyForSession(sessionID: string): string {
    const keys = remoteKeysForRoot(this.sessions, this.parents, rootSession(this.parents, sessionID))
    return keys.length === 1 ? keys[0] : ""
  }

  rootSession(sessionID: string): string {
    return rootSession(this.parents, sessionID)
  }

  eventCursor(): string {
    return this.cursor
  }

  async setEventCursor(cursor: string): Promise<void> {
    if (cursor === "" || this.cursor === cursor) return
    this.cursor = cursor
    await this.save()
  }

  private save(): Promise<void> {
    if (this.path === "") return Promise.resolve()
    // Snapshot synchronously so the queued write reflects this call's state.
    const snapshot = JSON.stringify(
      {
        sessions: Object.fromEntries(this.sessions),
        parents: Object.fromEntries(this.parents),
        ...(this.cursor ? { eventCursor: this.cursor } : {}),
      },
      null,
      2,
    )
    return queuePathWrite(this.path, () => this.writeSnapshot(snapshot))
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    const dir = dirname(this.path)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // Unique temp name per write so a second writer sharing this path cannot
    // clobber a fixed `<path>.tmp` mid-write; each renames its own snapshot.
    const tempPath = `${this.path}.${process.pid}.${tempSequence++}.tmp`
    try {
      // Mode 0o600 so the state file (remote keys / session IDs / cursor) is not
      // world/group-readable under a shared dir; matches Go's os.CreateTemp default.
      await writeFile(tempPath, snapshot, { mode: 0o600 })
      await rename(tempPath, this.path)
    } catch (err) {
      await unlink(tempPath).catch(() => {})
      throw err
    }
  }
}

/** Walk the parent chain from sessionID to its root; cycle-safe. */
export function rootSession(parents: Map<string, string>, sessionID: string): string {
  if (sessionID === "") return ""
  const seen = new Set<string>()
  let current = sessionID
  while (current !== "" && !seen.has(current)) {
    seen.add(current)
    const parent = parents.get(current) ?? ""
    if (parent === "") return current
    current = parent
  }
  return sessionID
}

/**
 * Whether walking the parent chain from `start` ever lands on `target`.
 * setParent uses it to reject a parentID whose ancestry already contains the
 * child, which would otherwise form a cycle.
 */
function parentChainReaches(parents: Map<string, string>, start: string, target: string): boolean {
  const seen = new Set<string>()
  for (let current = start; current !== "" && !seen.has(current); current = parents.get(current) ?? "") {
    if (current === target) return true
    seen.add(current)
  }
  return false
}

function hasRootConflict(
  sessions: Map<string, string>,
  parents: Map<string, string>,
  remoteKey: string,
  sessionID: string,
): boolean {
  const root = rootSession(parents, sessionID)
  if (root === "") return false
  for (const [currentKey, currentSession] of sessions) {
    if (currentKey !== remoteKey && rootSession(parents, currentSession) === root) return true
  }
  return false
}

function hasAnyRootConflict(sessions: Map<string, string>, parents: Map<string, string>): boolean {
  const seen = new Map<string, string>()
  for (const [remoteKey, sessionID] of sessions) {
    const root = rootSession(parents, sessionID)
    if (root === "") continue
    const current = seen.get(root)
    if (current && current !== remoteKey) return true
    seen.set(root, remoteKey)
  }
  return false
}

function withParent(parents: Map<string, string>, sessionID: string, parentID: string): Map<string, string> {
  const next = new Map(parents)
  next.set(sessionID, parentID)
  return next
}

function queuePathWrite(path: string, write: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(path) ?? Promise.resolve()
  const run = previous.then(write)
  const next = run.catch(() => {})
  writeQueues.set(path, next)
  void next.then(() => {
    if (writeQueues.get(path) === next) writeQueues.delete(path)
  })
  return run
}

function remoteKeysForRoot(sessions: Map<string, string>, parents: Map<string, string>, root: string): string[] {
  if (root === "") return []
  const keys: string[] = []
  for (const [remoteKey, current] of sessions) {
    if (rootSession(parents, current) === root) keys.push(remoteKey)
  }
  return keys
}
