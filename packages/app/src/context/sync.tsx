import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@opencode-ai/util/binary"
import { retry } from "@opencode-ai/util/retry"
import { createSimpleContext } from "@opencode-ai/ui/context"
import {
  clearSessionPrefetch,
  getSessionPrefetch,
  getSessionPrefetchPromise,
  setSessionPrefetch,
} from "./global-sync/session-prefetch"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { dropSessionCaches } from "./global-sync/session-cache"
import type { TodoHydrateReason } from "./global-sync/todo-hydrate-coordinator"
import { diffs as list, message as clean } from "@/utils/diffs"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

function sortParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
}

function runInflight(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>) {
  const pending = map.get(key)
  if (pending) return pending
  const promise = task().finally(() => {
    map.delete(key)
  })
  map.set(key, promise)
  return promise
}

const keyFor = (directory: string, id: string) => `${directory}\n${id}`

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function isNotFoundError(error: unknown) {
  if (!error || typeof error !== "object") return false
  const value = error as { name?: unknown; status?: unknown; statusCode?: unknown; response?: { status?: unknown } }
  if (value.name === "NotFoundError") return true
  if (value.status === 404 || value.statusCode === 404) return true
  return value.response?.status === 404
}

function merge<T extends { id: string }>(a: readonly T[], b: readonly T[]) {
  const map = new Map(a.map((item) => [item.id, item] as const))
  for (const item of b) map.set(item.id, item)
  return [...map.values()].sort((x, y) => cmp(x.id, y.id))
}

export function resolveLoadMessagePage<T extends { id: string }>(params: {
  stored: readonly T[] | undefined
  fetched: readonly T[]
}): T[] {
  const { stored, fetched } = params
  if (stored && stored.length > 0) return merge(stored, fetched)
  return fetched as T[]
}

export function resolveLoadMessagePageMeta(params: {
  mode?: "prepend" | "replace"
  previous?: {
    limit?: number
    cursor?: string
    complete?: boolean
  }
  messageCount: number
  fetchedCount: number
  fetchedCursor: string | undefined
  fetchedComplete: boolean
}) {
  const limit = Math.max(params.previous?.limit ?? 0, params.messageCount)
  const retainedExistingPage =
    params.mode !== "prepend" && params.previous?.limit !== undefined && params.messageCount > params.fetchedCount
  if (retainedExistingPage) {
    return {
      limit,
      cursor: params.previous?.complete ? undefined : (params.previous?.cursor ?? params.fetchedCursor),
      complete: params.previous?.complete ?? false,
    }
  }

  return {
    limit,
    cursor: params.fetchedCursor,
    complete: params.fetchedComplete,
  }
}

type OptimisticStore = {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}

type OptimisticAddInput = {
  sessionID: string
  message: Message
  parts: Part[]
}

type OptimisticRemoveInput = {
  sessionID: string
  messageID: string
}

type OptimisticItem = {
  message: Message
  parts: Part[]
}

export function createCurrentSyncChild<Child>(input: {
  directory: () => string | undefined
  child: (directory: string) => Child
}) {
  const initialDirectory = input.directory()
  let lastDirectory = typeof initialDirectory === "string" && initialDirectory.length > 0 ? initialDirectory : undefined

  return () => {
    const directory = input.directory()
    if (typeof directory === "string" && directory.length > 0) {
      lastDirectory = directory
      return input.child(directory)
    }

    return input.child(lastDirectory ?? (directory as string))
  }
}

export function syncChildOptionsForTarget(input: { currentDirectory: string | undefined; targetDirectory?: string }) {
  if (!input.targetDirectory || input.targetDirectory === input.currentDirectory) return
  return { bootstrap: false, pin: false } as const
}

type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

const hasParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return want.length === 0
  return want.every((part) => Binary.search(parts, part.id, (item) => item.id).found)
}

const mergeParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return sortParts(want)
  const next = [...parts]
  let changed = false
  for (const part of want) {
    const result = Binary.search(next, part.id, (item) => item.id)
    if (result.found) continue
    next.splice(result.index, 0, part)
    changed = true
  }
  if (!changed) return parts
  return next
}

export function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, sortParts(item.part)]))
  const confirmed: string[] = []

  for (const item of items) {
    const result = Binary.search(session, item.message.id, (message) => message.id)
    const found = result.found
    if (!found) session.splice(result.index, 0, item.message)

    const current = part.get(item.message.id)
    if (found && hasParts(current, item.parts)) {
      confirmed.push(item.message.id)
      continue
    }

    part.set(item.message.id, mergeParts(current, item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session,
    part: [...part.entries()].sort((a, b) => cmp(a[0], b[0])).map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

export function applyOptimisticAdd(draft: OptimisticStore, input: OptimisticAddInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const result = Binary.search(messages, input.message.id, (m) => m.id)
    messages.splice(result.index, 0, input.message)
  } else {
    draft.message[input.sessionID] = [input.message]
  }
  draft.part[input.message.id] = sortParts(input.parts)
}

export function applyOptimisticRemove(draft: OptimisticStore, input: OptimisticRemoveInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const result = Binary.search(messages, input.messageID, (m) => m.id)
    if (result.found) messages.splice(result.index, 1)
  }
  delete draft.part[input.messageID]
}

function setOptimisticAdd(setStore: (...args: unknown[]) => void, input: OptimisticAddInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return [input.message]
    const result = Binary.search(messages, input.message.id, (m) => m.id)
    const next = [...messages]
    next.splice(result.index, 0, input.message)
    return next
  })
  setStore("part", input.message.id, sortParts(input.parts))
}

function setOptimisticRemove(setStore: (...args: unknown[]) => void, input: OptimisticRemoveInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return messages
    const result = Binary.search(messages, input.messageID, (m) => m.id)
    if (!result.found) return messages
    const next = [...messages]
    next.splice(result.index, 1)
    return next
  })
  setStore("part", (part: Record<string, Part[] | undefined>) => {
    if (!(input.messageID in part)) return part
    const next = { ...part }
    delete next[input.messageID]
    return next
  })
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const globalSync = useGlobalSync()
    const sdk = useSDK()

    type Child = ReturnType<(typeof globalSync)["child"]>
    type Setter = Child[1]

    createEffect(() => {
      const directory = sdk.directory
      if (!directory) return
      const retained = globalSync.retainDirectory(directory)
      onCleanup(() => retained.release())
    })

    const current = createCurrentSyncChild({
      directory: () => sdk.directory,
      child: (directory) => globalSync.child(directory, { pin: false }),
    })
    const target = (directory?: string) => {
      const options = syncChildOptionsForTarget({ currentDirectory: sdk.directory, targetDirectory: directory })
      if (!options || !directory) return current()
      return globalSync.child(directory, options)
    }
    const retainTarget = (directory?: string) => {
      const targetDirectory = directory || sdk.directory
      if (!targetDirectory) {
        return {
          directory: "",
          get store() {
            return current()[0]
          },
          get setStore() {
            return current()[1]
          },
          release() {},
        }
      }
      return globalSync.retainDirectory(targetDirectory)
    }
    const absolute = (path: string) => (current()[0].path.directory + "/" + path).replace("//", "/")
    const initialMessagePageSize = 80
    const historyMessagePageSize = 200
    const inflight = new Map<string, Promise<void>>()
    const inflightDiff = new Map<string, Promise<void>>()
    const inflightTodo = new Map<string, Promise<void>>()
    const optimistic = new Map<string, Map<string, OptimisticItem>>()
    const [meta, setMeta] = createStore({
      limit: {} as Record<string, number>,
      cursor: {} as Record<string, string | undefined>,
      complete: {} as Record<string, boolean>,
      loading: {} as Record<string, boolean>,
    })

    const getSession = (sessionID: string) => {
      const store = current()[0]
      const match = Binary.search(store.session, sessionID, (s) => s.id)
      if (match.found) return store.session[match.index]
      return undefined
    }

    const setOptimistic = (directory: string, sessionID: string, item: OptimisticItem) => {
      const key = keyFor(directory, sessionID)
      const list = optimistic.get(key)
      if (list) {
        list.set(item.message.id, { message: item.message, parts: sortParts(item.parts) })
        return
      }
      optimistic.set(key, new Map([[item.message.id, { message: item.message, parts: sortParts(item.parts) }]]))
    }

    const clearOptimistic = (directory: string, sessionID: string, messageID?: string) => {
      const key = keyFor(directory, sessionID)
      if (!messageID) {
        optimistic.delete(key)
        return
      }

      const list = optimistic.get(key)
      if (!list) return
      list.delete(messageID)
      if (list.size === 0) optimistic.delete(key)
    }

    const getOptimistic = (directory: string, sessionID: string) => [
      ...(optimistic.get(keyFor(directory, sessionID))?.values() ?? []),
    ]

    const clearMeta = (directory: string, sessionIDs: string[]) => {
      if (sessionIDs.length === 0) return
      for (const sessionID of sessionIDs) {
        clearOptimistic(directory, sessionID)
      }
      setMeta(
        produce((draft) => {
          for (const sessionID of sessionIDs) {
            const key = keyFor(directory, sessionID)
            delete draft.limit[key]
            delete draft.cursor[key]
            delete draft.complete[key]
            delete draft.loading[key]
          }
        }),
      )
    }

    const evict = (directory: string, setStore: Setter, sessionIDs: string[]) => {
      if (sessionIDs.length === 0) return
      clearSessionPrefetch(directory, sessionIDs)
      for (const sessionID of sessionIDs) {
        clearOptimistic(directory, sessionID)
      }
      setStore(
        produce((draft) => {
          dropSessionCaches(draft, sessionIDs)
        }),
      )
      clearMeta(directory, sessionIDs)
    }

    const touch = (directory: string, setStore: Setter, sessionID: string) => {
      const evictions = globalSync.todoHydrate.touch(directory, sessionID)
      for (const item of evictions) {
        if (item.directory === directory) {
          evict(directory, setStore, item.sessionIDs)
          continue
        }
        const [, staleSetStore] = globalSync.child(item.directory, { bootstrap: false })
        evict(item.directory, staleSetStore, item.sessionIDs)
      }
    }

    const fetchMessages = async (input: {
      client: typeof sdk.client
      sessionID: string
      limit: number
      before?: string
    }) => {
      const messages = await retry(() =>
        input.client.session.messages({ sessionID: input.sessionID, limit: input.limit, before: input.before }),
      )
      const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
      const session = items.map((x) => clean(x.info)).sort((a, b) => cmp(a.id, b.id))
      const part = items.map((message) => ({ id: message.info.id, part: sortParts(message.parts) }))
      const cursor = messages.response?.headers.get("x-next-cursor") ?? undefined
      return {
        session,
        part,
        cursor,
        complete: !cursor,
      }
    }

    const tracked = (directory: string, sessionID: string) => globalSync.todoHydrate.has(directory, sessionID)

    const loadMessages = async (input: {
      directory: string
      client: typeof sdk.client
      setStore: Setter
      sessionID: string
      limit: number
      before?: string
      mode?: "replace" | "prepend"
    }) => {
      const key = keyFor(input.directory, input.sessionID)
      if (meta.loading[key]) return

      setMeta("loading", key, true)
      await fetchMessages(input)
        .then((page) => {
          if (!tracked(input.directory, input.sessionID)) return
          const next = mergeOptimisticPage(page, getOptimistic(input.directory, input.sessionID))
          for (const messageID of next.confirmed) {
            clearOptimistic(input.directory, input.sessionID, messageID)
          }
          const [store] = globalSync.child(input.directory, { bootstrap: false })
          const message = resolveLoadMessagePage({
            stored: store.message[input.sessionID],
            fetched: next.session,
          })
          const pageMeta = resolveLoadMessagePageMeta({
            mode: input.mode,
            previous: {
              limit: meta.limit[key],
              cursor: meta.cursor[key],
              complete: meta.complete[key],
            },
            messageCount: message.length,
            fetchedCount: next.session.length,
            fetchedCursor: next.cursor,
            fetchedComplete: next.complete,
          })
          batch(() => {
            input.setStore("message", input.sessionID, reconcile(message, { key: "id" }))
            for (const p of next.part) {
              const filtered = p.part.filter((x) => !SKIP_PARTS.has(x.type))
              if (filtered.length) input.setStore("part", p.id, filtered)
            }
            setMeta("limit", key, pageMeta.limit)
            setMeta("cursor", key, pageMeta.cursor)
            setMeta("complete", key, pageMeta.complete)
            setSessionPrefetch({
              directory: input.directory,
              sessionID: input.sessionID,
              limit: pageMeta.limit,
              cursor: pageMeta.cursor,
              complete: pageMeta.complete,
            })
          })
        })
        .finally(() => {
          setMeta(
            produce((draft) => {
              if (!tracked(input.directory, input.sessionID)) {
                delete draft.loading[key]
                return
              }
              draft.loading[key] = false
            }),
          )
        })
    }

    return {
      get data() {
        return current()[0]
      },
      get set(): Setter {
        return current()[1]
      },
      setFor(directory?: string): Setter {
        return target(directory)[1]
      },
      storeFor(directory?: string): Child[0] {
        return target(directory)[0]
      },
      retainDirectory(directory?: string) {
        return retainTarget(directory)
      },
      get status() {
        return current()[0].status
      },
      get ready() {
        return current()[0].status !== "loading"
      },
      get project() {
        const store = current()[0]
        const match = Binary.search(globalSync.data.project, store.project, (p) => p.id)
        if (match.found) return globalSync.data.project[match.index]
        return undefined
      },
      session: {
        get: getSession,
        optimistic: {
          add(input: { directory?: string; sessionID: string; message: Message; parts: Part[] }) {
            const directory = input.directory ?? sdk.directory
            const [, setStore] = target(input.directory)
            setOptimistic(directory, input.sessionID, { message: input.message, parts: input.parts })
            setOptimisticAdd(setStore as (...args: unknown[]) => void, input)
          },
          remove(input: { directory?: string; sessionID: string; messageID: string }) {
            const directory = input.directory ?? sdk.directory
            const [, setStore] = target(input.directory)
            clearOptimistic(directory, input.sessionID, input.messageID)
            setOptimisticRemove(setStore as (...args: unknown[]) => void, input)
          },
        },
        addOptimisticMessage(input: {
          sessionID: string
          messageID: string
          parts: Part[]
          agent: string
          model: { providerID: string; modelID: string }
          variant?: string
        }) {
          const message: Message = {
            id: input.messageID,
            sessionID: input.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: input.agent,
            model: { ...input.model, variant: input.variant },
          }
          const [, setStore] = target()
          setOptimistic(sdk.directory, input.sessionID, { message, parts: input.parts })
          setOptimisticAdd(setStore as (...args: unknown[]) => void, {
            sessionID: input.sessionID,
            message,
            parts: input.parts,
          })
        },
        async sync(sessionID: string, opts?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          const key = keyFor(directory, sessionID)

          touch(directory, setStore, sessionID)

          const seeded = getSessionPrefetch(directory, sessionID)
          if (seeded && store.message[sessionID] !== undefined && meta.limit[key] === undefined) {
            batch(() => {
              setMeta("limit", key, seeded.limit)
              setMeta("cursor", key, seeded.cursor)
              setMeta("complete", key, seeded.complete)
              setMeta("loading", key, false)
            })
          }

          return runInflight(inflight, key, async () => {
            const pending = getSessionPrefetchPromise(directory, sessionID)
            if (pending) {
              await pending
              const seeded = getSessionPrefetch(directory, sessionID)
              if (seeded && store.message[sessionID] !== undefined && meta.limit[key] === undefined) {
                batch(() => {
                  setMeta("limit", key, seeded.limit)
                  setMeta("cursor", key, seeded.cursor)
                  setMeta("complete", key, seeded.complete)
                  setMeta("loading", key, false)
                })
              }
            }

            const hasSession = Binary.search(store.session, sessionID, (s) => s.id).found
            const cached = store.message[sessionID] !== undefined && meta.limit[key] !== undefined
            if (cached && hasSession && !opts?.force) return

            const limit = meta.limit[key] ?? initialMessagePageSize
            const sessionReq =
              hasSession && !opts?.force
                ? Promise.resolve()
                : retry(() => client.session.get({ sessionID })).then((session) => {
                    if (!tracked(directory, sessionID)) return
                    const data = session.data
                    if (!data) return
                    setStore(
                      "session",
                      produce((draft) => {
                        const match = Binary.search(draft, sessionID, (s) => s.id)
                        if (match.found) {
                          draft[match.index] = data
                          return
                        }
                        draft.splice(match.index, 0, data)
                      }),
                    )
                  })

            const messagesReq =
              cached && !opts?.force
                ? Promise.resolve()
                : loadMessages({
                    directory,
                    client,
                    setStore,
                    sessionID,
                    limit,
                  })

            await Promise.all([sessionReq, messagesReq])
          })
        },
        async diff(sessionID: string, opts?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          touch(directory, setStore, sessionID)
          if (store.turn_change_aggregate[sessionID] !== undefined && !opts?.force) return

          const key = keyFor(directory, sessionID)
          return runInflight(inflightDiff, key, () =>
            retry(() => client.session.diff({ sessionID })).then((diff) => {
              if (!tracked(directory, sessionID)) return
              setStore("turn_change_aggregate", sessionID, reconcile(diff.data))
            }),
          )
        },
        async todo(sessionID: string, opts?: { force?: boolean; reason?: TodoHydrateReason }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          touch(directory, setStore, sessionID)
          const cached = globalSync.data.session_todo[sessionID]
          if (cached !== undefined) {
            setStore("todo", sessionID, reconcile(cached.todos, { key: "id" }))
            if (!opts?.force && opts?.reason !== "recovery") return
          }

          const key = keyFor(directory, sessionID)
          const reason = opts?.reason ?? (opts?.force ? "busy" : "visible")
          const inflightKey = `${key}\n${opts?.force || reason === "recovery" ? "force" : "normal"}`
          return runInflight(inflightTodo, inflightKey, async () => {
            const token = globalSync.todoHydrate.beginHydrate(directory, sessionID, reason)
            try {
              const todo = await retry(() => client.session.todo({ sessionID }))
              if (!globalSync.todoHydrate.isCurrent(token)) return
              const snapshot = todo.data
              if (!snapshot) {
                globalSync.todoHydrate.completeHydrate(token, {
                  cacheAccepted: false,
                  recoveryValidated: false,
                  liveWritesReopened: false,
                })
                return
              }
              const accepted = globalSync.todo.accept(sessionID, snapshot)
              const current = globalSync.data.session_todo[sessionID]
              if (current) setStore("todo", sessionID, reconcile(current.todos, { key: "id" }))
              globalSync.todoHydrate.completeHydrate(token, {
                cacheAccepted: accepted || current?.revision === snapshot.revision,
                recoveryValidated: true,
                liveWritesReopened: true,
              })
            } catch (err) {
              if (!isNotFoundError(err)) throw err
              if (!globalSync.todoHydrate.isCurrent(token)) return
              globalSync.todo.clearAuthoritative(sessionID)
              globalSync.todoHydrate.invalidateSession(sessionID)
              clearSessionPrefetch(directory, [sessionID])
              setStore(
                produce((draft) => {
                  dropSessionCaches(draft, [sessionID])
                }),
              )
              clearMeta(directory, [sessionID])
            }
          })
        },
        history: {
          more(sessionID: string) {
            const store = current()[0]
            const key = keyFor(sdk.directory, sessionID)
            if (store.message[sessionID] === undefined) return false
            if (meta.limit[key] === undefined) return false
            if (meta.complete[key]) return false
            return !!meta.cursor[key]
          },
          loading(sessionID: string) {
            const key = keyFor(sdk.directory, sessionID)
            return meta.loading[key] ?? false
          },
          async loadMore(sessionID: string, count?: number) {
            const directory = sdk.directory
            const client = sdk.client
            const [, setStore] = globalSync.child(directory)
            touch(directory, setStore, sessionID)
            const key = keyFor(directory, sessionID)
            const step = count ?? historyMessagePageSize
            if (meta.loading[key]) return
            if (meta.complete[key]) return
            const before = meta.cursor[key]
            if (!before) return

            await loadMessages({
              directory,
              client,
              setStore,
              sessionID,
              limit: step,
              before,
              mode: "prepend",
            })
          },
        },
        evict(sessionID: string, directory = sdk.directory) {
          const [, setStore] = globalSync.child(directory)
          globalSync.todoHydrate.invalidate(directory, sessionID)
          evict(directory, setStore, [sessionID])
        },
        fetch: async (count = 10) => {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          setStore("limit", (x) => x + count)
          await client.session.list().then((x) => {
            const sessions = (x.data ?? [])
              .filter((s) => !!s?.id)
              .sort((a, b) => cmp(a.id, b.id))
              .slice(0, store.limit)
            setStore("session", reconcile(sessions, { key: "id" }))
          })
        },
        more: createMemo(() => current()[0].session.length >= current()[0].limit),
      },
      absolute,
      get directory() {
        return current()[0].path.directory
      },
    }
  },
})
