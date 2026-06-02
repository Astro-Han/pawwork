import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { AutomationDefinition, AutomationDefinitionTombstone, AutomationRun } from "@opencode-ai/sdk/v2/client"
import type { State } from "./types"

// Definitions and runs carry a monotonic `revision`; deletions carry a tombstone
// revision. The HTTP list/get responses and the SSE events share that sequence,
// so a route response that lands after a newer event must be ignored. These
// helpers gate every write on revision so reconnect re-fetches and live events
// converge regardless of arrival order.

export function canAcceptAutomationDefinition(input: {
  current: AutomationDefinition | undefined
  tombstoneRevision: number | undefined
  incoming: AutomationDefinition
}): boolean {
  if (input.tombstoneRevision !== undefined && input.tombstoneRevision >= input.incoming.revision) return false
  return input.current === undefined || input.incoming.revision > input.current.revision
}

export function canAcceptAutomationTombstone(input: {
  currentRevision: number | undefined
  tombstoneRevision: number | undefined
  incoming: AutomationDefinitionTombstone
}): boolean {
  const baseline = Math.max(input.currentRevision ?? -1, input.tombstoneRevision ?? -1)
  return input.incoming.revision > baseline
}

export function canAcceptAutomationRun(input: {
  current: AutomationRun | undefined
  incoming: AutomationRun
}): boolean {
  return input.current === undefined || input.incoming.revision > input.current.revision
}

export function applyAutomationDefinition(
  store: Store<State>,
  setStore: SetStoreFunction<State>,
  incoming: AutomationDefinition,
): boolean {
  const current = store.automation[incoming.id]
  const tombstoneRevision = store.automation_tombstone[incoming.id]
  if (!canAcceptAutomationDefinition({ current, tombstoneRevision, incoming })) return false
  setStore("automation", incoming.id, incoming)
  return true
}

export function applyAutomationTombstone(
  store: Store<State>,
  setStore: SetStoreFunction<State>,
  incoming: AutomationDefinitionTombstone,
): boolean {
  const current = store.automation[incoming.id]
  const tombstoneRevision = store.automation_tombstone[incoming.id]
  if (!canAcceptAutomationTombstone({ currentRevision: current?.revision, tombstoneRevision, incoming })) return false
  if (current) {
    setStore(
      "automation",
      produce((draft) => {
        delete draft[incoming.id]
      }),
    )
  }
  setStore("automation_tombstone", incoming.id, incoming.revision)
  return true
}

export function applyAutomationRun(
  store: Store<State>,
  setStore: SetStoreFunction<State>,
  incoming: AutomationRun,
): boolean {
  const current = store.automation_run[incoming.id]
  if (!canAcceptAutomationRun({ current, incoming })) return false
  setStore("automation_run", incoming.id, incoming)
  return true
}

// Authoritative merge for the bootstrap `automation.list` snapshot: drop
// definitions the server no longer returns, skip re-adding a locally tombstoned
// id, and keep a locally newer revision when the snapshot is stale.
export function mergeAutomationList(
  store: Store<State>,
  setStore: SetStoreFunction<State>,
  items: AutomationDefinition[],
) {
  const next: Record<string, AutomationDefinition> = {}
  for (const incoming of items) {
    const tombstoneRevision = store.automation_tombstone[incoming.id]
    if (tombstoneRevision !== undefined && tombstoneRevision >= incoming.revision) continue
    const current = store.automation[incoming.id]
    next[incoming.id] = current && current.revision > incoming.revision ? current : incoming
  }
  setStore("automation", reconcile(next))
}

export function mergeAutomationRuns(
  store: Store<State>,
  setStore: SetStoreFunction<State>,
  items: AutomationRun[],
) {
  for (const incoming of items) {
    applyAutomationRun(store, setStore, incoming)
  }
}
