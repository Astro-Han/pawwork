import { beforeAll, describe, expect, mock, test } from "bun:test"
import type {
  localSavedStoreKey as LocalSavedStoreKey,
  pruneLocalSavedStores as PruneLocalSavedStores,
  shouldRestoreLocalSessionModel as ShouldRestoreLocalSessionModel,
} from "./local"

let localSavedStoreKey: typeof LocalSavedStoreKey
let pruneLocalSavedStores: typeof PruneLocalSavedStores
let shouldRestoreLocalSessionModel: typeof ShouldRestoreLocalSessionModel

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))

  const mod = await import("./local")
  localSavedStoreKey = mod.localSavedStoreKey
  pruneLocalSavedStores = mod.pruneLocalSavedStores
  shouldRestoreLocalSessionModel = mod.shouldRestoreLocalSessionModel
})

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
        savedReady: true,
        hasHandoff: false,
      }),
    ).toBe(true)
  })

  test("does not restore before the directory-local persisted store is ready", () => {
    expect(
      shouldRestoreLocalSessionModel({
        currentSessionID: "ses",
        messageSessionID: "ses",
        saved: undefined,
        savedReady: false,
        hasHandoff: false,
      }),
    ).toBe(false)
  })

  test("keeps an existing directory-local session choice authoritative", () => {
    expect(
      shouldRestoreLocalSessionModel({
        currentSessionID: "ses",
        messageSessionID: "ses",
        saved: { agent: "local" },
        savedReady: true,
        hasHandoff: false,
      }),
    ).toBe(false)
  })
})

describe("localSavedStoreKey", () => {
  test("does not create a persisted fallback bucket for an unknown directory", () => {
    expect(localSavedStoreKey("")).toBeUndefined()
    expect(localSavedStoreKey(undefined)).toBeUndefined()
    expect(localSavedStoreKey("/repo")).toBe("/repo")
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
