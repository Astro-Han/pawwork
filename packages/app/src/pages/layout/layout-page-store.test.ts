import { describe, expect, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import { PersistTesting } from "@/utils/persist"
import { createDefaultLayoutPageState, createLayoutPagePersistTarget, migrateLayoutPageState } from "./layout-page-store"

class ElectronPathStorage implements AsyncStorage {
  constructor(readonly data: Record<string, unknown> = {}) {}

  private path(key: string) {
    return key.split(".")
  }

  private read(key: string) {
    let current: unknown = this.data
    for (const part of this.path(key)) {
      if (!current || typeof current !== "object" || Array.isArray(current)) return undefined
      current = (current as Record<string, unknown>)[part]
    }
    return current
  }

  private write(key: string, value: unknown) {
    const parts = this.path(key)
    let current = this.data
    for (const part of parts.slice(0, -1)) {
      const next = current[part]
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        current[part] = {}
      }
      current = current[part] as Record<string, unknown>
    }
    current[parts[parts.length - 1]] = value
  }

  getItem(key: string) {
    const value = this.read(key)
    if (value === undefined || value === null) return Promise.resolve(null)
    return Promise.resolve(typeof value === "string" ? value : JSON.stringify(value))
  }

  setItem(key: string, value: string) {
    this.write(key, value)
    return Promise.resolve()
  }

  removeItem(key: string) {
    const parts = this.path(key)
    let current = this.data
    for (const part of parts.slice(0, -1)) {
      const next = current[part]
      if (!next || typeof next !== "object" || Array.isArray(next)) return Promise.resolve()
      current = next as Record<string, unknown>
    }
    delete current[parts[parts.length - 1]]
    return Promise.resolve()
  }
}

describe("layout page state migration", () => {
  test("restores pinned sessions from old desktop layout page path", () => {
    const migrated = migrateLayoutPageState({
      pawworkPinnedSessions: ["ses_a", "ses_a", "", 42],
      pawworkSortMode: "project",
    })

    expect(migrated).toMatchObject({
      pawworkPinnedSessions: ["ses_a"],
      pawworkSortMode: "project",
    })
  })

  test("restores pinned sessions from old layout object with nested page JSON", () => {
    const migrated = migrateLayoutPageState({
      sidebar: { opened: true },
      page: JSON.stringify({
        pawworkPinnedSessions: ["ses_nested"],
        pawworkSortMode: "project",
      }),
    })

    expect(migrated).toMatchObject({
      pawworkPinnedSessions: ["ses_nested"],
      pawworkSortMode: "project",
    })
  })

  test("falls back safely when old page JSON is damaged", () => {
    const migrated = migrateLayoutPageState({
      page: "{",
      pawworkPinnedSessions: ["ses_current"],
    })

    expect(migrated).toMatchObject({
      pawworkPinnedSessions: ["ses_current"],
      pawworkSortMode: "time",
    })
  })

  test("rejects plain main layout state as a layout-page migration source", () => {
    expect(
      migrateLayoutPageState({
        sidebar: { opened: true },
        rightPanel: { opened: false },
      }),
    ).toBeUndefined()
  })

  test("rejects damaged non-object layout-page migration sources", () => {
    expect(migrateLayoutPageState("not-json")).toBeUndefined()
    expect(migrateLayoutPageState([])).toBeUndefined()
  })

  test("rejects nested page objects without layout-page fields", () => {
    expect(
      migrateLayoutPageState({
        page: { sidebar: { opened: true } },
      }),
    ).toBeUndefined()
  })
})

describe("layout page persistence target", () => {
  test("uses an unambiguous key and reads old same-storage keys", () => {
    const target = createLayoutPagePersistTarget()

    expect(target.key).toBe("layout-page")
    expect(target.currentLegacy).toEqual(["layout.page", "layout"])
    expect(target.legacy).toEqual(["layout.page.v1"])
  })
})

describe("layout page desktop persistence migration", () => {
  async function readFromDesktopStore(current: ElectronPathStorage, legacyStore = new ElectronPathStorage()) {
    const target = createLayoutPagePersistTarget()
    const raw = await PersistTesting.readPersistedAsync({
      current,
      legacyStore,
      key: target.key,
      defaults: createDefaultLayoutPageState(),
      currentLegacy: target.currentLegacy ?? [],
      legacy: target.legacy ?? [],
      migrate: target.migrate,
    })
    return JSON.parse(raw ?? "{}") as ReturnType<typeof createDefaultLayoutPageState>
  }

  test("restores from electron-store nested layout.page", async () => {
    const current = new ElectronPathStorage({
      layout: {
        page: JSON.stringify({
          pawworkPinnedSessions: ["ses_desktop"],
          pawworkSortMode: "project",
        }),
      },
    })

    const restored = await readFromDesktopStore(current)

    expect(restored.pawworkPinnedSessions).toEqual(["ses_desktop"])
    expect(restored.pawworkSortMode).toBe("project")
    expect(JSON.parse((current.data["layout-page"] as string) ?? "{}").pawworkPinnedSessions).toEqual(["ses_desktop"])
  })

  test("restores when the main layout key has already been normalized to a JSON string", async () => {
    const current = new ElectronPathStorage({
      layout: JSON.stringify({
        page: JSON.stringify({
          pawworkPinnedSessions: ["ses_layout_string"],
        }),
      }),
    })

    const restored = await readFromDesktopStore(current)

    expect(restored.pawworkPinnedSessions).toEqual(["ses_layout_string"])
    expect(JSON.parse((current.data["layout-page"] as string) ?? "{}").pawworkPinnedSessions).toEqual([
      "ses_layout_string",
    ])
  })

  test("keeps current layout-page ahead of stale desktop legacy values", async () => {
    const current = new ElectronPathStorage({
      "layout-page": JSON.stringify({
        pawworkPinnedSessions: ["ses_current"],
      }),
      layout: {
        page: JSON.stringify({
          pawworkPinnedSessions: ["ses_stale"],
        }),
      },
    })

    const restored = await readFromDesktopStore(current)

    expect(restored.pawworkPinnedSessions).toEqual(["ses_current"])
  })
})
