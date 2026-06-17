import { beforeAll, describe, expect, mock, test } from "bun:test"
import type {
  createModelActions as CreateModelActions,
  localSavedStoreKey as LocalSavedStoreKey,
  localPersistReadyForAction as LocalPersistReadyForAction,
  pruneLocalSavedStores as PruneLocalSavedStores,
  shouldRestoreLocalSessionModel as ShouldRestoreLocalSessionModel,
} from "./local"

let createModelActions: typeof CreateModelActions
let localSavedStoreKey: typeof LocalSavedStoreKey
let localPersistReadyForAction: typeof LocalPersistReadyForAction
let pruneLocalSavedStores: typeof PruneLocalSavedStores
let shouldRestoreLocalSessionModel: typeof ShouldRestoreLocalSessionModel

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))

  const mod = await import("./local")
  createModelActions = mod.createModelActions
  localSavedStoreKey = mod.localSavedStoreKey
  localPersistReadyForAction = mod.localPersistReadyForAction
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

describe("localPersistReadyForAction", () => {
  test("allows manual actions after persisted init fails or times out", () => {
    expect(localPersistReadyForAction({ ready: false, failed: false, timedOut: false })).toBe(false)
    expect(localPersistReadyForAction({ ready: true, failed: false, timedOut: false })).toBe(true)
    expect(localPersistReadyForAction({ ready: false, failed: true, timedOut: false })).toBe(true)
    expect(localPersistReadyForAction({ ready: false, failed: false, timedOut: true })).toBe(true)
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

describe("createModelActions recent-model wiring", () => {
  // Two connected models, the first "current" — enough to exercise set() and
  // cycle() without standing up the Local context.
  function setup() {
    const calls = {
      recordRecent: [] as Array<{ providerID: string; modelID: string }>,
      pushRecent: [] as Array<{ providerID: string; modelID: string }>,
      write: [] as Array<{ providerID: string; modelID: string } | undefined>,
    }
    const recent = [
      { provider: { id: "anthropic" }, id: "claude" },
      { provider: { id: "openai" }, id: "gpt" },
    ]
    const actions = createModelActions({
      batch: <T>(fn: () => T): T => fn(),
      recordLast: () => {},
      write: (item) => calls.write.push(item),
      setVisibility: () => {},
      pushRecent: (item) => calls.pushRecent.push(item),
      recordRecent: async (ref) => {
        calls.recordRecent.push(ref)
      },
      recent: () => recent,
      current: () => recent[0],
    })
    return { actions, calls }
  }

  test("an explicit pick mirrors the choice to the server's recent-model default", () => {
    const { actions, calls } = setup()
    actions.set({ providerID: "anthropic", modelID: "claude" }, { recent: true })
    expect(calls.recordRecent).toEqual([{ providerID: "anthropic", modelID: "claude" }])
    expect(calls.pushRecent).toEqual([{ providerID: "anthropic", modelID: "claude" }])
  })

  test("a non-recent set (programmatic / agent-pinned) never touches the server default", () => {
    const { actions, calls } = setup()
    actions.set({ providerID: "anthropic", modelID: "claude" })
    expect(calls.recordRecent).toEqual([])
    expect(calls.pushRecent).toEqual([])
    // the selection is still applied locally — it just isn't promoted to default
    expect(calls.write).toEqual([{ providerID: "anthropic", modelID: "claude" }])
  })

  test("cycling between recent models never re-records the default", () => {
    const { actions, calls } = setup()
    actions.cycle(1)
    expect(calls.recordRecent).toEqual([])
    // cycle still moved the selection on to the next recent model
    expect(calls.write).toEqual([{ providerID: "openai", modelID: "gpt" }])
  })
})
