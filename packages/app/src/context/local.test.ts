import { describe, expect, test } from "bun:test"
import { pruneLocalSavedStores, shouldRestoreLocalSessionModel } from "./local"

const entry = (id: string, lastAccessAt: number, disposed: string[]) => ({
  lastAccessAt,
  dispose: () => disposed.push(id),
})

describe("shouldRestoreLocalSessionModel", () => {
  test("restores only for the current session when no directory-local choice exists", () => {
    expect(
      shouldRestoreLocalSessionModel({
        currentSessionID: "ses",
        messageSessionID: "ses",
        saved: undefined,
        hasHandoff: false,
      }),
    ).toBe(true)
  })

  test("keeps an existing directory-local session choice authoritative", () => {
    expect(
      shouldRestoreLocalSessionModel({
        currentSessionID: "ses",
        messageSessionID: "ses",
        saved: { agent: "local" },
        hasHandoff: false,
      }),
    ).toBe(false)
  })
})

describe("pruneLocalSavedStores", () => {
  test("evicts least-recent stores without clearing the current directory", () => {
    const disposed: string[] = []
    const stores = new Map([
      ["oldest", entry("oldest", 1, disposed)],
      ["current", entry("current", 2, disposed)],
      ["newer", entry("newer", 3, disposed)],
    ])

    pruneLocalSavedStores(stores, "current", 2)

    expect([...stores.keys()]).toEqual(["current", "newer"])
    expect(disposed).toEqual(["oldest"])
  })
})
