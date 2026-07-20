import { createHash, randomUUID } from "node:crypto"
import { renameSync } from "node:fs"
import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { Session } from "electron"

export type BrowserProfileSession = Pick<Session, "clearStorageData" | "clearCache">

export type BrowserProfileSessionDeps<ProfileSession extends BrowserProfileSession> = {
  rootPath(): string
  fromPath(path: string): ProfileSession
}

/**
 * Owns PawWork's explicit browser-profile directories and every Electron
 * Session opened from them in this process. Electron retains opened Sessions
 * until exit, so Clear Data uses its API for those and removes only directories
 * that this process never opened.
 */
export class BrowserProfileSessions<ProfileSession extends BrowserProfileSession = BrowserProfileSession> {
  private readonly opened = new Map<string, ProfileSession>()
  private clearing: Promise<void> | undefined

  constructor(private readonly deps: BrowserProfileSessionDeps<ProfileSession>) {}

  private profilePath(profileID: string) {
    const directory = createHash("sha256").update(profileID).digest("hex")
    return join(this.deps.rootPath(), directory)
  }

  sessionFor(profileID: string): ProfileSession {
    const profilePath = this.profilePath(profileID)
    const existing = this.opened.get(profilePath)
    if (existing) return existing
    const created = this.deps.fromPath(profilePath)
    this.opened.set(profilePath, created)
    return created
  }

  clearAll(): Promise<void> {
    if (this.clearing) return this.clearing
    const clearing = this.clearOnce()
    this.clearing = clearing
    void clearing.then(
      () => {
        if (this.clearing === clearing) this.clearing = undefined
      },
      () => {
        if (this.clearing === clearing) this.clearing = undefined
      },
    )
    return clearing
  }

  private async clearOnce(): Promise<void> {
    for (const profileSession of this.opened.values()) {
      await profileSession.clearStorageData()
      await profileSession.clearCache()
    }
    const root = this.deps.rootPath()
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      const entryPath = join(root, entry)
      if (this.opened.has(entryPath)) continue
      // Rename without yielding so sessionFor cannot open this path between the
      // ownership check and removal. A concurrent open then gets a fresh path.
      const removingPath = `${entryPath}.removing-${randomUUID()}`
      try {
        renameSync(entryPath, removingPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      await rm(removingPath, { recursive: true, force: true })
    }
  }
}
