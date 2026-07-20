import { randomUUID } from "node:crypto"
import { draftWindowID } from "./registry"

export type BrowserProfileStorage = {
  read(): unknown
  write(profiles: Record<string, string>): void
}

export class BrowserProfileRegistry {
  private profiles: Record<string, string> | undefined

  constructor(
    private readonly storage: BrowserProfileStorage,
    private readonly createID: () => string = randomUUID,
  ) {}

  private readProfiles(): Record<string, string> {
    if (this.profiles) return this.profiles
    const stored = this.storage.read()
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return (this.profiles = {})
    const used = new Set<string>()
    this.profiles = Object.fromEntries(
      Object.entries(stored).filter(([ownerKey, profileID]) => {
        if (
          draftWindowID(ownerKey) !== null ||
          typeof profileID !== "string" ||
          profileID.length === 0 ||
          used.has(profileID)
        )
          return false
        used.add(profileID)
        return true
      }),
    )
    return this.profiles
  }

  private persist() {
    this.storage.write({ ...this.readProfiles() })
  }

  profileFor(ownerKey: string): string {
    // Home drafts are window-lifetime owners. Never persist by draft:<windowID>:
    // that key is reused after adoption and would make the old conversation and
    // the window's next draft share a Chromium session again.
    if (draftWindowID(ownerKey) !== null) return this.createID()
    const profiles = this.readProfiles()
    const existing = profiles[ownerKey]
    if (existing) return existing
    const created = this.createID()
    profiles[ownerKey] = created
    this.persist()
    return created
  }

  /** Persist a draft controller's immutable profile under its adopted session. */
  adopt(sessionID: string, profileID: string) {
    if (draftWindowID(sessionID) !== null || !sessionID || !profileID) return
    this.readProfiles()[sessionID] = profileID
    this.persist()
  }
}
