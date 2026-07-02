import { describe, expect, test } from "bun:test"
import type { AutomationDefinition, AutomationRun } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import {
  applyAutomationDefinition,
  applyAutomationMoveResult,
  applyAutomationRun,
  applyAutomationTombstone,
  canAcceptAutomationDefinition,
  canAcceptAutomationRun,
  canAcceptAutomationTombstone,
  mergeAutomationList,
} from "./automation-store"

const definition = (input: { id: string; revision: number; title?: string; paused?: boolean; projectID?: string }): AutomationDefinition =>
  ({
    kind: "recurring",
    id: input.id,
    title: input.title ?? input.id,
    prompt: "do the thing",
    revision: input.revision,
    paused: input.paused ?? false,
    context: "fresh",
    where: { projectID: input.projectID ?? "prj_1" },
    createdAt: 1,
    updatedAt: 1,
    timezone: "UTC",
    normalizationWarnings: [],
    model: { providerID: "anthropic", modelID: "claude" },
    rhythm: { kind: "cron", expression: "0 9 * * *" },
    stop: { kind: "never" },
    nextFireAt: 1,
    nextFires: [1],
    failureStreak: 0,
  }) as AutomationDefinition

const run = (input: { id: string; automationID: string; revision: number; state?: AutomationRun["state"] }): AutomationRun =>
  ({
    id: input.id,
    automationID: input.automationID,
    revision: input.revision,
    definitionRevision: 1,
    triggeredAt: 1,
    cost: null,
    state: input.state ?? "scheduled",
    sessionID: null,
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
  }) as AutomationRun

const baseState = (input: Partial<State> = {}) =>
  ({
    automation: {},
    automation_run: {},
    automation_tombstone: {},
    ...input,
  }) as State

describe("canAcceptAutomationDefinition", () => {
  test("accepts when no current and no tombstone", () => {
    expect(
      canAcceptAutomationDefinition({ current: undefined, tombstoneRevision: undefined, incoming: definition({ id: "a", revision: 1 }) }),
    ).toBe(true)
  })

  test("accepts a strictly higher revision", () => {
    expect(
      canAcceptAutomationDefinition({
        current: definition({ id: "a", revision: 2 }),
        tombstoneRevision: undefined,
        incoming: definition({ id: "a", revision: 3 }),
      }),
    ).toBe(true)
  })

  test("rejects an equal or stale revision", () => {
    const current = definition({ id: "a", revision: 3 })
    expect(canAcceptAutomationDefinition({ current, tombstoneRevision: undefined, incoming: definition({ id: "a", revision: 3 }) })).toBe(false)
    expect(canAcceptAutomationDefinition({ current, tombstoneRevision: undefined, incoming: definition({ id: "a", revision: 2 }) })).toBe(false)
  })

  test("rejects an update at or below the tombstone revision", () => {
    expect(
      canAcceptAutomationDefinition({ current: undefined, tombstoneRevision: 5, incoming: definition({ id: "a", revision: 5 }) }),
    ).toBe(false)
    expect(
      canAcceptAutomationDefinition({ current: undefined, tombstoneRevision: 5, incoming: definition({ id: "a", revision: 4 }) }),
    ).toBe(false)
  })
})

describe("canAcceptAutomationTombstone", () => {
  test("accepts when newer than both current and prior tombstone", () => {
    expect(canAcceptAutomationTombstone({ currentRevision: 2, tombstoneRevision: undefined, incoming: { id: "a", deleted: true, revision: 3 } })).toBe(true)
  })

  test("rejects when not newer than the known max revision", () => {
    expect(canAcceptAutomationTombstone({ currentRevision: 3, tombstoneRevision: undefined, incoming: { id: "a", deleted: true, revision: 3 } })).toBe(false)
    expect(canAcceptAutomationTombstone({ currentRevision: undefined, tombstoneRevision: 4, incoming: { id: "a", deleted: true, revision: 4 } })).toBe(false)
  })
})

describe("canAcceptAutomationRun", () => {
  test("accepts first run and strictly higher revisions", () => {
    expect(canAcceptAutomationRun({ current: undefined, incoming: run({ id: "r", automationID: "a", revision: 1 }) })).toBe(true)
    expect(
      canAcceptAutomationRun({ current: run({ id: "r", automationID: "a", revision: 1 }), incoming: run({ id: "r", automationID: "a", revision: 2 }) }),
    ).toBe(true)
  })

  test("rejects stale run revisions", () => {
    expect(
      canAcceptAutomationRun({ current: run({ id: "r", automationID: "a", revision: 2 }), incoming: run({ id: "r", automationID: "a", revision: 2 }) }),
    ).toBe(false)
  })
})

describe("applyAutomationDefinition", () => {
  test("inserts then ignores a stale revision", () => {
    const [store, setStore] = createStore(baseState())
    expect(applyAutomationDefinition(store, setStore, definition({ id: "a", revision: 2, title: "v2" }))).toBe(true)
    expect(store.automation["a"]?.title).toBe("v2")
    expect(applyAutomationDefinition(store, setStore, definition({ id: "a", revision: 1, title: "v1" }))).toBe(false)
    expect(store.automation["a"]?.title).toBe("v2")
  })

  test("ignores an update for a tombstoned id", () => {
    const [store, setStore] = createStore(baseState({ automation_tombstone: { a: 5 } }))
    expect(applyAutomationDefinition(store, setStore, definition({ id: "a", revision: 5 }))).toBe(false)
    expect(store.automation["a"]).toBeUndefined()
  })
})

describe("applyAutomationTombstone", () => {
  test("removes the definition and fences a late stale update (route-after-event race)", () => {
    const [store, setStore] = createStore(baseState({ automation: { a: definition({ id: "a", revision: 2 }) } }))
    expect(applyAutomationTombstone(store, setStore, { id: "a", deleted: true, revision: 3 })).toBe(true)
    expect(store.automation["a"]).toBeUndefined()
    expect(store.automation_tombstone["a"]).toBe(3)
    // A list/get response computed before the delete must not resurrect it.
    expect(applyAutomationDefinition(store, setStore, definition({ id: "a", revision: 2 }))).toBe(false)
    expect(store.automation["a"]).toBeUndefined()
  })
})

describe("applyAutomationMoveResult", () => {
  test("tombstones the source and writes the target only after the response confirms the target project", () => {
    const [source, setSource] = createStore(baseState({ automation: { a: definition({ id: "a", revision: 1, projectID: "source" }) } }))
    const [target, setTarget] = createStore(baseState())
    const moved = definition({ id: "a", revision: 2, projectID: "target" })

    const applied = applyAutomationMoveResult({
      source: [source, setSource],
      target: [target, setTarget],
      automationID: "a",
      targetProjectID: "target",
      incoming: moved,
    })

    expect(applied).toBe("target")
    expect(source.automation["a"]).toBeUndefined()
    expect(source.automation_tombstone["a"]).toBe(2)
    expect(target.automation["a"]).toBe(moved)
  })

  test("falls back to the source update when a stale target does not match the response project", () => {
    const [source, setSource] = createStore(baseState({ automation: { a: definition({ id: "a", revision: 1, projectID: "source" }) } }))
    const [target, setTarget] = createStore(baseState())
    const response = definition({ id: "a", revision: 2, projectID: "actual" })

    const applied = applyAutomationMoveResult({
      source: [source, setSource],
      target: [target, setTarget],
      automationID: "a",
      targetProjectID: "stale",
      incoming: response,
    })

    expect(applied).toBe("source")
    expect(source.automation["a"]).toEqual(response)
    expect(source.automation_tombstone["a"]).toBeUndefined()
    expect(target.automation["a"]).toBeUndefined()
  })
})

describe("applyAutomationRun", () => {
  test("upserts then ignores a stale run", () => {
    const [store, setStore] = createStore(baseState())
    expect(applyAutomationRun(store, setStore, run({ id: "r", automationID: "a", revision: 1 }))).toBe(true)
    expect(applyAutomationRun(store, setStore, run({ id: "r", automationID: "a", revision: 2, state: "running" }))).toBe(true)
    expect(store.automation_run["r"]?.state).toBe("running")
    expect(applyAutomationRun(store, setStore, run({ id: "r", automationID: "a", revision: 1 }))).toBe(false)
    expect(store.automation_run["r"]?.state).toBe("running")
  })
})

describe("mergeAutomationList", () => {
  test("drops missing ids, skips tombstoned, keeps locally newer", () => {
    const [store, setStore] = createStore(
      baseState({
        automation: { gone: definition({ id: "gone", revision: 1 }), live: definition({ id: "live", revision: 4, title: "local-v4" }) },
        automation_tombstone: { deleted: 2 },
      }),
    )
    mergeAutomationList(
      store,
      setStore,
      [
        definition({ id: "live", revision: 3, title: "stale-v3" }),
        definition({ id: "fresh", revision: 1 }),
        definition({ id: "deleted", revision: 2 }),
      ],
      new Set(["gone", "live"]),
    )
    expect(store.automation["gone"]).toBeUndefined()
    expect(store.automation["deleted"]).toBeUndefined()
    expect(store.automation["fresh"]?.id).toBe("fresh")
    expect(store.automation["live"]?.title).toBe("local-v4")
  })

  test("preserves a definition created after the snapshot request was issued", () => {
    const [store, setStore] = createStore(
      baseState({
        automation: {
          existing: definition({ id: "existing", revision: 1 }),
          created: definition({ id: "created", revision: 1, title: "live-arrival" }),
        },
      }),
    )
    // The snapshot only lists "existing"; "created" landed via SSE while the
    // request was in flight, so it must survive the reconcile.
    mergeAutomationList(store, setStore, [definition({ id: "existing", revision: 1 })], new Set(["existing"]))
    expect(store.automation["existing"]?.id).toBe("existing")
    expect(store.automation["created"]?.title).toBe("live-arrival")
  })
})
