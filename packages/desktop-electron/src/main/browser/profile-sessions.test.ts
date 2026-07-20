import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrowserProfileSessions } from "./profile-sessions"

describe("BrowserProfileSessions", () => {
  test("reuses a session only for the same browser profile", () => {
    const paths: string[] = []
    const profiles = new BrowserProfileSessions({
      rootPath: () => "/browser-profiles",
      fromPath: (path) => {
        paths.push(path)
        return { clearStorageData: async () => {}, clearCache: async () => {} }
      },
    })

    const first = profiles.sessionFor("profile-a")
    expect(profiles.sessionFor("profile-a")).toBe(first)
    expect(profiles.sessionFor("profile-b")).not.toBe(first)
    expect(paths).toHaveLength(2)
    expect(paths[0]).not.toBe(paths[1])
  })

  test("clears successfully before the profile directory exists", async () => {
    const root = join(tmpdir(), `pawwork-browser-profiles-missing-${randomUUID()}`)
    const profiles = new BrowserProfileSessions({
      rootPath: () => root,
      fromPath: () => ({ clearStorageData: async () => {}, clearCache: async () => {} }),
    })

    await expect(profiles.clearAll()).resolves.toBeUndefined()
  })

  test("removes unopened profile data without creating an Electron session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pawwork-browser-profiles-"))
    const historical = join(root, "historical-profile")
    mkdirSync(historical)
    writeFileSync(join(historical, "Cookies"), "stored browser data")
    let createdSessions = 0
    const profiles = new BrowserProfileSessions({
      rootPath: () => root,
      fromPath: () => {
        createdSessions += 1
        return { clearStorageData: async () => {}, clearCache: async () => {} }
      },
    })

    try {
      await profiles.clearAll()
      expect(existsSync(historical)).toBe(false)
      expect(createdSessions).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("clears opened Electron sessions sequentially without deleting their directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "pawwork-browser-profiles-"))
    let activeOperations = 0
    let maxActiveOperations = 0
    let storageClears = 0
    let cacheClears = 0
    const operation = async (record: () => void) => {
      activeOperations += 1
      maxActiveOperations = Math.max(maxActiveOperations, activeOperations)
      await Promise.resolve()
      record()
      activeOperations -= 1
    }
    const profiles = new BrowserProfileSessions({
      rootPath: () => root,
      fromPath: (path) => {
        mkdirSync(path, { recursive: true })
        return {
          clearStorageData: () => operation(() => (storageClears += 1)),
          clearCache: () => operation(() => (cacheClears += 1)),
        }
      },
    })

    profiles.sessionFor("profile-a")
    profiles.sessionFor("profile-b")

    try {
      await profiles.clearAll()
      expect(storageClears).toBe(2)
      expect(cacheClears).toBe(2)
      expect(maxActiveOperations).toBe(1)
      expect(await readdir(root)).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("coalesces concurrent clear requests", async () => {
    const root = join(tmpdir(), `pawwork-browser-profiles-missing-${randomUUID()}`)
    let releaseStorage!: () => void
    const storageReleased = new Promise<void>((resolve) => (releaseStorage = resolve))
    let storageClears = 0
    let cacheClears = 0
    const profiles = new BrowserProfileSessions({
      rootPath: () => root,
      fromPath: () => ({
        clearStorageData: async () => {
          storageClears += 1
          await storageReleased
        },
        clearCache: async () => {
          cacheClears += 1
        },
      }),
    })
    profiles.sessionFor("profile-a")

    const first = profiles.clearAll()
    await Promise.resolve()
    const second = profiles.clearAll()
    await Promise.resolve()
    const clearsWhileBlocked = storageClears
    releaseStorage()
    await Promise.all([first, second])

    expect(clearsWhileBlocked).toBe(1)
    expect(storageClears).toBe(1)
    expect(cacheClears).toBe(1)
  })
})
