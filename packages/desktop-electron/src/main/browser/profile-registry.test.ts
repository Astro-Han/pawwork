import { describe, expect, test } from "bun:test"
import { draftKey } from "./registry"
import { BrowserProfileRegistry, type BrowserProfileStorage } from "./profile-registry"

function memoryStorage(initial: unknown = {}) {
  let value = initial
  const storage: BrowserProfileStorage = {
    read: () => value,
    write: (profiles) => {
      value = profiles
    },
  }
  return { storage, value: () => value }
}

function ids(...values: string[]) {
  let index = 0
  return () => values[index++] ?? `profile-${index}`
}

describe("BrowserProfileRegistry", () => {
  test("gives each session a stable persistent profile", () => {
    const memory = memoryStorage()
    const profiles = new BrowserProfileRegistry(memory.storage, ids("profile-a", "profile-b"))

    expect(profiles.profileFor("ses_a")).toBe("profile-a")
    expect(profiles.profileFor("ses_a")).toBe("profile-a")
    expect(profiles.profileFor("ses_b")).toBe("profile-b")
    expect(memory.value()).toEqual({ ses_a: "profile-a", ses_b: "profile-b" })

    const restored = new BrowserProfileRegistry(memory.storage, ids("unused"))
    expect(restored.profileFor("ses_a")).toBe("profile-a")
    expect(restored.profileIDs()).toEqual(["profile-a", "profile-b"])
  })

  test("keeps draft profiles unique and binds the adopted profile to its new session", () => {
    const memory = memoryStorage()
    const profiles = new BrowserProfileRegistry(memory.storage, ids("draft-a", "draft-b"))

    const firstDraft = profiles.profileFor(draftKey(1))
    const secondDraft = profiles.profileFor(draftKey(2))
    expect(firstDraft).toBe("draft-a")
    expect(secondDraft).toBe("draft-b")

    profiles.adopt("ses_new", firstDraft)
    expect(profiles.profileFor("ses_new")).toBe("draft-a")
    expect(memory.value()).toEqual({ ses_new: "draft-a" })
  })

  test("repairs duplicate stored profiles instead of restoring shared session state", () => {
    const memory = memoryStorage({ ses_a: "shared", ses_b: "shared" })
    const profiles = new BrowserProfileRegistry(memory.storage, ids("profile-b"))

    expect(profiles.profileFor("ses_a")).toBe("shared")
    expect(profiles.profileFor("ses_b")).toBe("profile-b")
    expect(memory.value()).toEqual({ ses_a: "shared", ses_b: "profile-b" })
  })
})
