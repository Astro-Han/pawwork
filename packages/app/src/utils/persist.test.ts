import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"

type PersistTestingType = typeof import("./persist").PersistTesting
type ShouldDebugPersistedTerminalRead = typeof import("./persist").shouldDebugPersistedTerminalRead

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  private failingSets = new Map<string, number>()
  readonly events: string[] = []
  readonly calls = { get: 0, set: 0, remove: 0 }

  clear() {
    this.values.clear()
    this.failingSets.clear()
  }

  failSet(key: string, times: number) {
    this.failingSets.set(key, times)
  }

  get length() {
    return this.values.size
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }

  getItem(key: string) {
    this.calls.get += 1
    this.events.push(`get:${key}`)
    if (key.startsWith("pawwork.throw")) throw new Error("storage get failed")
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.calls.set += 1
    this.events.push(`set:${key}`)
    const remaining = this.failingSets.get(key) ?? 0
    if (remaining > 0) {
      this.failingSets.set(key, remaining - 1)
      throw new DOMException("quota", "QuotaExceededError")
    }
    if (key.startsWith("pawwork.quota")) throw new DOMException("quota", "QuotaExceededError")
    if (key.startsWith("pawwork.throw")) throw new Error("storage set failed")
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.calls.remove += 1
    this.events.push(`remove:${key}`)
    if (key.startsWith("pawwork.throw")) throw new Error("storage remove failed")
    this.values.delete(key)
  }
}

const storage = new MemoryStorage()

function asyncMemoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const api: AsyncStorage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value)
    },
    removeItem: async (key) => {
      values.delete(key)
    },
  }
  return { api, values }
}

let persistTesting: PersistTestingType
let shouldDebugPersistedTerminalRead: ShouldDebugPersistedTerminalRead

beforeAll(async () => {
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ platform: "web" }),
  }))

  const mod = await import("./persist")
  persistTesting = mod.PersistTesting
  shouldDebugPersistedTerminalRead = mod.shouldDebugPersistedTerminalRead
})

beforeEach(() => {
  storage.clear()
  storage.events.length = 0
  storage.calls.get = 0
  storage.calls.set = 0
  storage.calls.remove = 0
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  })
})

describe("persist localStorage resilience", () => {
  test("does not cache values as persisted when quota write and eviction fail", () => {
    const storageApi = persistTesting.localStorageWithPrefix("pawwork.quota.scope")
    storageApi.setItem("value", '{"value":1}')

    expect(storage.getItem("pawwork.quota.scope:value")).toBeNull()
    expect(storageApi.getItem("value")).toBeNull()
  })

  test("disables only the failing scope when storage throws", () => {
    const bad = persistTesting.localStorageWithPrefix("pawwork.throw.scope")
    bad.setItem("value", '{"value":1}')

    const before = storage.calls.set
    bad.setItem("value", '{"value":2}')
    expect(storage.calls.set).toBe(before)
    expect(bad.getItem("value")).toBeNull()

    const healthy = persistTesting.localStorageWithPrefix("pawwork.safe.scope")
    healthy.setItem("value", '{"value":3}')
    expect(storage.getItem("pawwork.safe.scope:value")).toBe('{"value":3}')
  })

  test("failing fallback scope does not poison direct storage scope", () => {
    const broken = persistTesting.localStorageWithPrefix("pawwork.throw.scope2")
    broken.setItem("value", '{"value":1}')

    const direct = persistTesting.localStorageDirect()
    direct.setItem("direct-value", '{"value":5}')

    expect(storage.getItem("direct-value")).toBe('{"value":5}')
  })

  test("quota eviction can remove legacy OpenCode local entries", () => {
    storage.setItem("opencode.workspace.old.dat:value", "old workspace")
    storage.setItem("opencode.global.dat:value", "old global")
    storage.setItem("opencode.settings.dat:value", "old settings")
    storage.failSet("pawwork.workspace.new.dat:value", 4)

    const storageApi = persistTesting.localStorageWithPrefix("pawwork.workspace.new.dat")
    storageApi.setItem("value", '{"value":1}')

    expect(storage.getItem("opencode.workspace.old.dat:value")).toBeNull()
    expect(storage.getItem("opencode.global.dat:value")).toBeNull()
    expect(storage.getItem("opencode.settings.dat:value")).toBeNull()
    expect(storage.getItem("pawwork.workspace.new.dat:value")).toBe('{"value":1}')
  })

  test("normalizer rejects malformed JSON payloads", () => {
    const result = persistTesting.normalize({ value: "ok" }, '{"value":"\\x"}')
    expect(result).toBeUndefined()
  })

  test("current key wins over same-storage legacy keys", () => {
    const current = persistTesting.localStorageWithPrefix("pawwork.global.dat")
    const legacy = persistTesting.localStorageDirect()
    current.removeItem("layout-page")
    current.removeItem("layout.page")
    current.setItem("layout-page", JSON.stringify({ pinned: ["current"] }))
    current.setItem("layout.page", JSON.stringify({ pinned: ["old"] }))

    const result = persistTesting.readPersistedSync({
      current,
      legacyStore: legacy,
      key: "layout-page",
      defaults: { pinned: [] as string[] },
      currentLegacy: ["layout.page"],
      legacy: [],
    })

    expect(JSON.parse(result ?? "{}")).toEqual({ pinned: ["current"] })
  })

  test("same-storage legacy keys migrate into the current key", () => {
    const current = persistTesting.localStorageWithPrefix("pawwork.global.dat")
    const legacy = persistTesting.localStorageDirect()
    current.removeItem("layout-page")
    current.removeItem("layout.page")
    current.setItem("layout.page", JSON.stringify({ pinned: ["old"] }))

    const result = persistTesting.readPersistedSync({
      current,
      legacyStore: legacy,
      key: "layout-page",
      defaults: { pinned: [] as string[] },
      currentLegacy: ["layout.page"],
      legacy: [],
    })

    expect(JSON.parse(result ?? "{}")).toEqual({ pinned: ["old"] })
    expect(JSON.parse(storage.getItem("pawwork.global.dat:layout-page") ?? "{}")).toEqual({
      pinned: ["old"],
    })
  })

  test("invalid same-storage legacy values do not block legacy storage fallback", () => {
    const current = persistTesting.localStorageWithPrefix("pawwork.global.dat")
    const legacy = persistTesting.localStorageDirect()
    current.removeItem("layout-page")
    current.removeItem("layout")
    current.setItem("layout", JSON.stringify({ sidebar: { opened: true } }))
    legacy.setItem("layout.page.v1", JSON.stringify({ pinned: ["legacy"] }))

    const result = persistTesting.readPersistedSync({
      current,
      legacyStore: legacy,
      key: "layout-page",
      defaults: { pinned: [] as string[] },
      currentLegacy: ["layout"],
      legacy: ["layout.page.v1"],
      migrate: (value) => ("pinned" in (value as Record<string, unknown>) ? value : undefined),
    })

    expect(JSON.parse(result ?? "{}")).toEqual({ pinned: ["legacy"] })
    expect(legacy.getItem("layout.page.v1")).toBeNull()
  })

  test("async reader removes malformed current values without legacy fallback", async () => {
    const current = asyncMemoryStorage({ "layout-page": "{" })
    const legacy = asyncMemoryStorage({ "layout.page.v1": JSON.stringify({ pinned: ["legacy"] }) })

    const result = await persistTesting.readPersistedAsync({
      current: current.api,
      legacyStore: legacy.api,
      key: "layout-page",
      defaults: { pinned: [] as string[] },
      currentLegacy: [],
      legacy: ["layout.page.v1"],
    })

    expect(result).toBeNull()
    expect(current.values.has("layout-page")).toBeFalse()
    expect(legacy.values.has("layout.page.v1")).toBeTrue()
  })

  test("workspace storage sanitizes Windows filename characters", () => {
    const result = persistTesting.workspaceStorage("C:\\Users\\foo")

    expect(result).toStartWith("pawwork.workspace.")
    expect(result.endsWith(".dat")).toBeTrue()
    expect(/[:\\/]/.test(result)).toBeFalse()
  })

  test("does not emit workspace terminal persisted debug logs outside dev", () => {
    expect(shouldDebugPersistedTerminalRead("workspace:terminal", false)).toBe(false)
  })

  test("keeps workspace terminal persisted debug logs dev-only", () => {
    expect(shouldDebugPersistedTerminalRead("workspace:terminal", true)).toBe(true)
    expect(shouldDebugPersistedTerminalRead("layout-page", true)).toBe(false)
  })
})
