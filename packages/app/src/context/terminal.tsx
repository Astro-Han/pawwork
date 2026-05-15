import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createMemo, createRoot, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "./sdk"
import type { Platform } from "./platform"
import { defaultTitle, titleNumber } from "./terminal-title"
import { createTerminalLifecycle } from "./terminal-lifecycle"
import {
  assertNoUnsafeTerminalStorageFields,
  migratePersistedTerminalState,
  sanitizePersistedTerminalState,
} from "./terminal-storage"
import {
  runtimePTYID,
  terminalTabID,
  type PersistedTerminalStateV2,
  type RuntimePTY,
  type TerminalSnapshot,
  type TerminalTab,
  type TerminalTabID,
} from "./terminal-types"
import { Persist, persisted, removePersisted } from "@/utils/persist"

const WORKSPACE_KEY = "__workspace__"
const MAX_TERMINAL_SESSIONS = 20

export type TerminalTitleUpdate = {
  tabID: TerminalTabID
  title: string
}

type TerminalSession = ReturnType<typeof createWorkspaceTerminalSession>
type TerminalSessionLike = {
  ready: () => boolean
  all: () => TerminalTab[]
  active: () => TerminalTabID | undefined
  connection: (tabID: TerminalTabID) => RuntimePTY | undefined
  clear: () => void
  new: () => void
  update: (input: TerminalTitleUpdate) => void
  snapshot: (tabID: TerminalTabID, snapshot: TerminalSnapshot) => void
  resize: (tabID: TerminalTabID, size: NonNullable<TerminalSnapshot["size"]>) => void
  ensureLive: (tabID: TerminalTabID) => Promise<RuntimePTY | undefined>
  markGone: (tabID: TerminalTabID) => void
  open: (id: TerminalTabID) => void
  next: () => void
  previous: () => void
  close: (id: TerminalTabID) => Promise<void>
  move: (id: TerminalTabID, to: number) => void
}

type TerminalCacheEntry = {
  value: TerminalSession
  dispose: VoidFunction
}

const caches = new Set<Map<string, TerminalCacheEntry>>()

export function isTerminalGoneError(error: unknown) {
  if (!error || typeof error !== "object") return false
  const value = error as {
    name?: unknown
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
  }
  if (value.name === "NotFoundError") return true
  if (value.status === 404 || value.statusCode === 404) return true
  return value.response?.status === 404
}

export function getWorkspaceTerminalCacheKey(dir: string) {
  return `${dir}:${WORKSPACE_KEY}`
}

export function getLegacyTerminalStorageKeys(dir: string, legacySessionID?: string) {
  if (!legacySessionID) return [`${dir}/terminal.v1`]
  return [`${dir}/terminal/${legacySessionID}.v1`, `${dir}/terminal.v1`]
}

function sortedTabs(tabs: TerminalTab[]) {
  return tabs.slice().sort((a, b) => a.order - b.order)
}

function normalizeOrder(tabs: TerminalTab[]) {
  return sortedTabs(tabs).map((tab, order) => ({ ...tab, order }))
}

function nextTerminalTabID() {
  return terminalTabID(`tab_${crypto.randomUUID()}`)
}

function assertSafeTerminalState(value: PersistedTerminalStateV2) {
  if (!import.meta.env.DEV && !import.meta.env.TEST) return
  assertNoUnsafeTerminalStorageFields(value)
}

export function clearWorkspaceTerminals(dir: string, sessionIDs?: string[], platform?: Platform) {
  const key = getWorkspaceTerminalCacheKey(dir)
  for (const cache of caches) {
    const entry = cache.get(key)
    entry?.value.clear()
  }

  void removePersisted(Persist.workspace(dir, "terminal"), platform)

  const legacy = new Set(getLegacyTerminalStorageKeys(dir))
  for (const id of sessionIDs ?? []) {
    for (const key of getLegacyTerminalStorageKeys(dir, id)) {
      legacy.add(key)
    }
  }
  for (const key of legacy) {
    void removePersisted({ key }, platform)
  }
}

function createWorkspaceTerminalSession(sdk: ReturnType<typeof useSDK>, dir: string, legacySessionID?: string) {
  const legacy = getLegacyTerminalStorageKeys(dir, legacySessionID)
  const [runtimeVersion, setRuntimeVersion] = createSignal(0)
  const bumpRuntime = () => setRuntimeVersion((value) => value + 1)

  const [store, setStore, _, ready] = persisted(
    {
      ...Persist.workspace(dir, "terminal", legacy),
      migrate: migratePersistedTerminalState,
    },
    createStore<PersistedTerminalStateV2>({
      version: 2,
      tabs: [],
    }),
  )

  const persistSafeState = () => {
    const sanitized = sanitizePersistedTerminalState(store)
    assertSafeTerminalState(sanitized)
    if (JSON.stringify(sanitized) === JSON.stringify(store)) return
    batch(() => {
      setStore("version", sanitized.version)
      setStore("activeTabID", sanitized.activeTabID)
      setStore("tabs", sanitized.tabs)
    })
  }

  createEffect(
    on(
      ready,
      (initialized) => {
        if (!initialized) return
        untrack(persistSafeState)
      },
      { defer: true },
    ),
  )

  const lifecycle = createTerminalLifecycle({
    create: async ({ title }) => {
      const result = await sdk.client.pty.create({ title })
      const id = result.data?.id
      if (!id) throw new Error("PTY create did not return an id")
      return {
        ptyID: runtimePTYID(id),
        title: result.data?.title ?? title,
      }
    },
    remove: async (ptyID) => {
      await sdk.client.pty.remove({ ptyID }).catch(() => undefined)
    },
  })

  const all = createMemo(() => sortedTabs(store.tabs))

  const pickNextTerminalNumber = () => {
    const existingTitleNumbers = new Set(
      store.tabs.flatMap((tab) => {
        const direct = Number.isFinite(tab.titleNumber) && tab.titleNumber > 0 ? tab.titleNumber : undefined
        if (direct !== undefined) return [direct]
        const parsed = titleNumber(tab.title, MAX_TERMINAL_SESSIONS)
        if (parsed === undefined) return []
        return [parsed]
      }),
    )

    return (
      Array.from({ length: existingTitleNumbers.size + 1 }, (_, index) => index + 1).find(
        (number) => !existingTitleNumbers.has(number),
      ) ?? 1
    )
  }

  const tabIndex = (tabID: TerminalTabID) => store.tabs.findIndex((tab) => tab.tabID === tabID)

  const ensureLive = async (tabID: TerminalTabID) => {
    const tab = store.tabs.find((item) => item.tabID === tabID)
    if (!tab) return
    try {
      const runtime = await lifecycle.ensureLive({ tabID, title: tab.title })
      bumpRuntime()
      return runtime
    } catch (error) {
      console.error("Failed to create terminal runtime", error)
      return undefined
    }
  }

  const markGone = (tabID: TerminalTabID) => {
    lifecycle.markGone(tabID)
    bumpRuntime()
    if (store.activeTabID === tabID) void ensureLive(tabID)
  }

  const syncRuntime = (tabID: TerminalTabID, input: { title?: string; size?: NonNullable<TerminalSnapshot["size"]> }) => {
    const runtime = lifecycle.peek(tabID)
    if (!runtime) return
    sdk.client.pty
      .update({
        ptyID: runtime.ptyID,
        title: input.title,
        size: input.size,
      })
      .catch((error: unknown) => {
        if (isTerminalGoneError(error)) {
          markGone(tabID)
          return
        }
        console.error("Failed to update terminal", error)
      })
  }

  const removeExited = (runtimeID: string) => {
    const tab = store.tabs.find((item) => lifecycle.peek(item.tabID)?.ptyID === runtimeID)
    if (!tab) return
    lifecycle.removeRuntime(tab.tabID)
    bumpRuntime()
    const tabs = all()
    const index = tabs.findIndex((item) => item.tabID === tab.tabID)
    batch(() => {
      if (store.activeTabID === tab.tabID) {
        const next = index > 0 ? tabs[index - 1]?.tabID : tabs[1]?.tabID
        setStore("activeTabID", next)
      }
      setStore(
        "tabs",
        produce((draft) => {
          const currentIndex = draft.findIndex((item) => item.tabID === tab.tabID)
          if (currentIndex !== -1) draft.splice(currentIndex, 1)
          const normalized = normalizeOrder(draft)
          draft.splice(0, draft.length, ...normalized)
        }),
      )
    })
  }

  const unsub = sdk.event.on("pty.exited", (event: { properties: { id: string } }) => {
    removeExited(event.properties.id)
  })
  onCleanup(unsub)

  createEffect(
    on(
      () => `${sdk.url}:${dir}`,
      () => {
        lifecycle.clearRuntime()
        bumpRuntime()
      },
      { defer: true },
    ),
  )

  return {
    ready,
    all,
    active: createMemo(() => store.activeTabID),
    connection(tabID: TerminalTabID) {
      runtimeVersion()
      return lifecycle.peek(tabID)
    },
    clear() {
      lifecycle.clearRuntime()
      bumpRuntime()
      batch(() => {
        setStore("activeTabID", undefined)
        setStore("tabs", [])
      })
    },
    new() {
      const nextNumber = pickNextTerminalNumber()
      const tabID = nextTerminalTabID()
      const tab = {
        tabID,
        title: defaultTitle(nextNumber),
        titleNumber: nextNumber,
        order: store.tabs.length,
      } satisfies TerminalTab

      batch(() => {
        setStore("tabs", store.tabs.length, tab)
        setStore("activeTabID", tabID)
      })
      void ensureLive(tabID)
    },
    update(input: TerminalTitleUpdate) {
      const index = tabIndex(input.tabID)
      if (index === -1) return
      setStore("tabs", index, (tab) => ({ ...tab, title: input.title }))
      syncRuntime(input.tabID, { title: input.title })
    },
    snapshot(tabID: TerminalTabID, snapshot: TerminalSnapshot) {
      const index = tabIndex(tabID)
      if (index === -1) return
      if (Object.keys(snapshot).length === 0) {
        setStore("tabs", index, (tab) => ({ ...tab, snapshot: undefined }))
        return
      }
      setStore("tabs", index, (tab) => ({
        ...tab,
        snapshot: {
          ...tab.snapshot,
          ...snapshot,
        },
      }))
    },
    resize(tabID: TerminalTabID, size: NonNullable<TerminalSnapshot["size"]>) {
      syncRuntime(tabID, { size })
    },
    ensureLive,
    markGone,
    open(id: TerminalTabID) {
      if (!store.tabs.some((tab) => tab.tabID === id)) return
      setStore("activeTabID", id)
      void ensureLive(id)
    },
    next() {
      const tabs = all()
      const index = tabs.findIndex((tab) => tab.tabID === store.activeTabID)
      if (index === -1) return
      setStore("activeTabID", tabs[(index + 1) % tabs.length]?.tabID)
    },
    previous() {
      const tabs = all()
      const index = tabs.findIndex((tab) => tab.tabID === store.activeTabID)
      if (index === -1) return
      const prevIndex = index === 0 ? tabs.length - 1 : index - 1
      setStore("activeTabID", tabs[prevIndex]?.tabID)
    },
    async close(id: TerminalTabID) {
      const tabs = all()
      const index = tabs.findIndex((tab) => tab.tabID === id)
      if (index === -1) return

      lifecycle.removeRuntime(id)
      bumpRuntime()
      batch(() => {
        if (store.activeTabID === id) {
          const next = index > 0 ? tabs[index - 1]?.tabID : tabs[1]?.tabID
          setStore("activeTabID", next)
        }
        setStore(
          "tabs",
          produce((draft) => {
            const currentIndex = draft.findIndex((tab) => tab.tabID === id)
            if (currentIndex !== -1) draft.splice(currentIndex, 1)
            const normalized = normalizeOrder(draft)
            draft.splice(0, draft.length, ...normalized)
          }),
        )
      })
    },
    move(id: TerminalTabID, to: number) {
      const tabs = all()
      const index = tabs.findIndex((tab) => tab.tabID === id)
      if (index === -1) return
      const next = tabs.slice()
      next.splice(to, 0, next.splice(index, 1)[0])
      setStore("tabs", next.map((tab, order) => ({ ...tab, order })))
    },
  }
}

function createEmptyTerminalSession(): TerminalSessionLike {
  const all = createMemo<TerminalTab[]>(() => [])
  const active = createMemo<TerminalTabID | undefined>(() => undefined)

  return {
    ready: () => false,
    all,
    active,
    connection: () => undefined,
    clear() {},
    new() {},
    update() {},
    snapshot() {},
    resize() {},
    async ensureLive() {
      return undefined
    },
    markGone() {},
    open() {},
    next() {},
    previous() {},
    async close() {},
    move() {},
  }
}

export function createTerminalBinding(workspace: Accessor<TerminalSessionLike | undefined>) {
  const fallback = createEmptyTerminalSession()
  const current = () => workspace() ?? fallback
  return {
    ready: () => current().ready(),
    all: () => current().all(),
    active: () => current().active(),
    connection: (tabID: TerminalTabID) => current().connection(tabID),
    new: () => current().new(),
    update: (input: TerminalTitleUpdate) => current().update(input),
    snapshot: (tabID: TerminalTabID, snapshot: TerminalSnapshot) => current().snapshot(tabID, snapshot),
    resize: (tabID: TerminalTabID, size: NonNullable<TerminalSnapshot["size"]>) => current().resize(tabID, size),
    ensureLive: (tabID: TerminalTabID) => current().ensureLive(tabID),
    markGone: (tabID: TerminalTabID) => current().markGone(tabID),
    open: (id: TerminalTabID) => current().open(id),
    close: (id: TerminalTabID) => current().close(id),
    move: (id: TerminalTabID, to: number) => current().move(id, to),
    next: () => current().next(),
    previous: () => current().previous(),
  }
}

export const { use: useTerminal, provider: TerminalProvider } = createSimpleContext({
  name: "Terminal",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const params = useParams()
    const cache = new Map<string, TerminalCacheEntry>()

    caches.add(cache)
    onCleanup(() => caches.delete(cache))

    const disposeAll = () => {
      for (const entry of cache.values()) {
        entry.dispose()
      }
      cache.clear()
    }

    onCleanup(disposeAll)

    const prune = () => {
      while (cache.size > MAX_TERMINAL_SESSIONS) {
        const first = cache.keys().next().value
        if (!first) return
        const entry = cache.get(first)
        entry?.dispose()
        cache.delete(first)
      }
    }

    const loadWorkspace = (dir: string, legacySessionID?: string) => {
      const key = getWorkspaceTerminalCacheKey(dir)
      const existing = cache.get(key)
      if (existing) {
        cache.delete(key)
        cache.set(key, existing)
        return existing.value
      }

      const entry = createRoot((dispose) => ({
        value: createWorkspaceTerminalSession(sdk, dir, legacySessionID),
        dispose,
      }))

      cache.set(key, entry)
      prune()
      return entry.value
    }

    const workspace = createMemo(() => {
      const dir = params.dir
      if (!dir) return
      return loadWorkspace(dir, params.id)
    })

    return createTerminalBinding(workspace)
  },
})
