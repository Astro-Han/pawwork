import { describe, expect, test } from "bun:test"
import { createRoot, getOwner } from "solid-js"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import { createChildStoreManager } from "./child-store"
import { ChildStoreError, type ChildStorePersistedFactory } from "./child-store-error"

const child = () => createStore({} as State)

function createManager(persist?: ChildStorePersistedFactory) {
  const owner = createRoot((dispose) => {
    const current = getOwner()
    dispose()
    return current
  })
  if (!owner) throw new Error("owner required")

  return createChildStoreManager({
    owner,
    persist,
    isBooting: () => false,
    isLoadingSessions: () => false,
    onBootstrap() {},
    onDispose() {},
    translate: (key) => {
      if (key === "error.childStore.persistedCacheCreateFailed") return "Failed to create persisted cache"
      return key
    },
  })
}

describe("createChildStoreManager", () => {
  test("does not evict the active directory during mark", () => {
    const manager = createManager()

    Array.from({ length: 30 }, (_, index) => `/pinned-${index}`).forEach((directory) => {
      manager.children[directory] = child()
      manager.pin(directory)
    })

    const directory = "/active"
    manager.children[directory] = child()
    manager.mark(directory)

    expect(manager.children[directory]).toBeDefined()
  })

  test("rejects invalid runtime directories before persisted cache setup", () => {
    const manager = createManager()

    expect(() => manager.child(undefined as unknown as string)).toThrow("Invalid workspace directory for child store")
  })

  test("preserves persisted setup cause and workspace target context", () => {
    const cause = new TypeError("storage init failed")
    const persist: ChildStorePersistedFactory = () => {
      throw cause
    }
    const manager = createManager(persist)

    try {
      manager.child("/tmp/project")
    } catch (error) {
      expect(error).toBeInstanceOf(ChildStoreError)
      expect(error).toHaveProperty("cause", cause)
      expect((error as ChildStoreError).message).toContain("Failed to create persisted cache")
      expect((error as ChildStoreError).message).toContain("cache=vcs")
      expect((error as ChildStoreError).message).toContain("key=workspace:vcs")
      expect((error as ChildStoreError).context.kind).toBe("vcs")
      expect((error as ChildStoreError).context.directory).toBe("/tmp/project")
      expect((error as ChildStoreError).context.key).toBe("workspace:vcs")
      expect((error as ChildStoreError).context.storage).toStartWith("pawwork.workspace.-tmp-project.")
      return
    }

    throw new Error("expected child store creation to throw")
  })

  test("does not publish partial cache state when a later persisted cache fails", () => {
    const cause = new TypeError("project storage init failed")
    const directory = "/tmp/project"
    let calls = 0
    const persist: ChildStorePersistedFactory = (_target, store) => {
      calls += 1
      if (calls === 2) throw cause
      return [store[0], store[1], null, Object.assign(() => true, { promise: undefined })]
    }
    const manager = createManager(persist)

    try {
      manager.child(directory)
    } catch (error) {
      expect(error).toBeInstanceOf(ChildStoreError)
      expect(error).toHaveProperty("cause", cause)
      expect(manager.children[directory]).toBeUndefined()
      expect(manager.vcsCache.has(directory)).toBe(false)
      expect(manager.metaCache.has(directory)).toBe(false)
      expect(manager.iconCache.has(directory)).toBe(false)
      return
    }

    throw new Error("expected child store creation to throw")
  })
})
