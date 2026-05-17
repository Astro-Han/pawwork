import { Platform, usePlatform } from "@/context/platform"
import { makePersisted, type AsyncStorage, type SyncStorage } from "@solid-primitives/storage"
import { checksum } from "@opencode-ai/util/encode"
import { createResource, type Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"
import { localStorageDirect, localStorageWithPrefix } from "./persist-local-storage"
import { normalize, readPersistedAsync, readPersistedSync } from "./persist-read"

type InitType = Promise<string> | string | null
type PersistedWithReady<T> = [
  Store<T>,
  SetStoreFunction<T>,
  InitType,
  Accessor<boolean> & { promise: undefined | Promise<any> },
]

type PersistTarget = {
  storage?: string
  key: string
  legacy?: string[]
  currentLegacy?: string[]
  migrate?: (value: unknown) => unknown
}

const LEGACY_STORAGE = "default.dat"
const GLOBAL_STORAGE = "pawwork.global.dat"

function snapshot(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function workspaceStorage(dir: string) {
  const head = (dir.slice(0, 12) || "workspace").replace(/[^a-zA-Z0-9._-]/g, "-")
  const sum = checksum(dir) ?? "0"
  return `pawwork.workspace.${head}.${sum}.dat`
}

export const PersistTesting = {
  localStorageDirect,
  localStorageWithPrefix,
  normalize,
  readPersistedAsync,
  readPersistedSync,
  workspaceStorage,
}

export function shouldDebugPersistedTerminalRead(key: string, dev = !!import.meta.env?.DEV) {
  return dev && key === "workspace:terminal"
}

export const Persist = {
  global(key: string, legacy?: string[]): PersistTarget {
    return { storage: GLOBAL_STORAGE, key, legacy }
  },
  workspace(dir: string, key: string, legacy?: string[]): PersistTarget {
    return { storage: workspaceStorage(dir), key: `workspace:${key}`, legacy }
  },
  session(dir: string, session: string, key: string, legacy?: string[]): PersistTarget {
    return { storage: workspaceStorage(dir), key: `session:${session}:${key}`, legacy }
  },
  scoped(dir: string, session: string | undefined, key: string, legacy?: string[]): PersistTarget {
    if (session) return Persist.session(dir, session, key, legacy)
    return Persist.workspace(dir, key, legacy)
  },
}

export function removePersisted(target: { storage?: string; key: string }, platform?: Platform) {
  const isDesktop = platform?.platform === "desktop" && !!platform.storage

  if (isDesktop) {
    return platform.storage?.(target.storage)?.removeItem(target.key)
  }

  if (!target.storage) {
    localStorageDirect().removeItem(target.key)
    return
  }

  localStorageWithPrefix(target.storage).removeItem(target.key)
}

export function persisted<T>(
  target: string | PersistTarget,
  store: [Store<T>, SetStoreFunction<T>],
): PersistedWithReady<T> {
  const platform = usePlatform()
  const config: PersistTarget = typeof target === "string" ? { key: target } : target

  const defaults = snapshot(store[0])
  const legacy = config.legacy ?? []
  const currentLegacy = config.currentLegacy ?? []

  const isDesktop = platform.platform === "desktop" && !!platform.storage

  const currentStorage = (() => {
    if (isDesktop) return platform.storage?.(config.storage)
    if (!config.storage) return localStorageDirect()
    return localStorageWithPrefix(config.storage)
  })()

  const legacyStorage = (() => {
    if (!isDesktop) return localStorageDirect()
    if (!config.storage) return platform.storage?.()
    return platform.storage?.(LEGACY_STORAGE)
  })()

  const storage = (() => {
    if (!isDesktop) {
      const current = currentStorage as SyncStorage
      const legacyStore = legacyStorage as SyncStorage
      const debugTerminal = shouldDebugPersistedTerminalRead(config.key)

      const api: SyncStorage = {
        getItem: (key) => {
          const next = readPersistedSync({
            current,
            legacyStore,
            key,
            defaults,
            legacy,
            currentLegacy,
            migrate: config.migrate,
          })
          if (debugTerminal) {
            console.debug("[persisted:workspace:terminal:sync]", {
              storage: config.storage,
              key,
              normalizedPreview: next?.slice(0, 240),
              normalizedLength: next?.length,
            })
          }
          return next
        },
        setItem: (key, value) => {
          current.setItem(key, value)
        },
        removeItem: (key) => {
          current.removeItem(key)
        },
      }

      return api
    }

    const current = currentStorage as AsyncStorage
    const legacyStore = legacyStorage as AsyncStorage | undefined
    const debugTerminal = shouldDebugPersistedTerminalRead(config.key)

    const api: AsyncStorage = {
      getItem: async (key) => {
        const next = await readPersistedAsync({
          current,
          legacyStore,
          key,
          defaults,
          legacy,
          currentLegacy,
          migrate: config.migrate,
        })
        if (debugTerminal) {
          console.debug("[persisted:workspace:terminal:async]", {
            storage: config.storage,
            key,
            normalizedPreview: next?.slice(0, 240),
            normalizedLength: next?.length,
          })
        }
        return next
      },
      setItem: async (key, value) => {
        await current.setItem(key, value)
      },
      removeItem: async (key) => {
        await current.removeItem(key)
      },
    }

    return api
  })()

  const [state, setState, init] = makePersisted(store, { name: config.key, storage })

  const isAsync = init instanceof Promise
  const [ready] = createResource(
    () => init,
    async (initValue) => {
      if (initValue instanceof Promise) await initValue
      return true
    },
    { initialValue: !isAsync },
  )

  return [
    state,
    setState,
    init,
    Object.assign(() => ready() === true, {
      promise: init instanceof Promise ? init : undefined,
    }),
  ]
}
