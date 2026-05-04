import { describe, expect, test } from "bun:test"
import { createLayoutPagePersistTarget, migrateLayoutPageState } from "./layout-page-store"

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
