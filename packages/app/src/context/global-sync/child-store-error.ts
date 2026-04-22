import { runWithOwner, type Owner } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"
import { persisted } from "@/utils/persist"

export type ChildStoreCacheKind = "workspace" | "vcs" | "project" | "icon"

export type ChildStoreErrorContext = {
  kind: ChildStoreCacheKind
  directory: unknown
  storage?: string
  key?: string
}

export type ChildStorePersistTarget = {
  storage?: string
  key: string
  legacy?: string[]
  migrate?: (value: unknown) => unknown
}

type PersistedResult<T> = ReturnType<typeof persisted<T>>

export type ChildStorePersistedFactory = <T>(
  target: ChildStorePersistTarget,
  store: [Store<T>, SetStoreFunction<T>],
) => PersistedResult<T>

export class ChildStoreError extends Error {
  readonly context: ChildStoreErrorContext

  constructor(message: string, context: ChildStoreErrorContext, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "ChildStoreError"
    this.context = context
  }
}

function describeDirectory(directory: unknown) {
  if (typeof directory === "string") return directory.length > 0 ? JSON.stringify(directory) : "empty string"
  if (directory === undefined) return "undefined"
  if (directory === null) return "null"
  try {
    const json = JSON.stringify(directory)
    return `${typeof directory}: ${json ?? String(directory)}`
  } catch {
    return `${typeof directory}: <unserializable>`
  }
}

function contextDetails(context: ChildStoreErrorContext) {
  return [
    `cache=${context.kind}`,
    context.storage ? `storage=${context.storage}` : undefined,
    context.key ? `key=${context.key}` : undefined,
    `directory=${describeDirectory(context.directory)}`,
  ]
    .filter((part): part is string => !!part)
    .join(", ")
}

export function validateChildStoreDirectory(directory: unknown): asserts directory is string {
  if (typeof directory === "string" && directory.length > 0) return
  throw new ChildStoreError(`Invalid workspace directory for child store: ${describeDirectory(directory)}`, {
    kind: "workspace",
    directory,
  })
}

export function createChildStorePersistedCacheError(input: {
  translate: (key: string) => string
  messageKey: string
  context: ChildStoreErrorContext
  cause?: unknown
}) {
  return new ChildStoreError(`${input.translate(input.messageKey)} (${contextDetails(input.context)})`, input.context, {
    cause: input.cause,
  })
}

export function createPersistedChildCache<T>(input: {
  owner: Owner
  directory: string
  kind: Exclude<ChildStoreCacheKind, "workspace">
  messageKey: string
  target: ChildStorePersistTarget
  store: [Store<T>, SetStoreFunction<T>]
  translate: (key: string) => string
  persist?: ChildStorePersistedFactory
}) {
  const persist: ChildStorePersistedFactory = input.persist ?? persisted
  const context: ChildStoreErrorContext = {
    kind: input.kind,
    directory: input.directory,
    storage: input.target.storage,
    key: input.target.key,
  }
  let cause: unknown

  try {
    const cache = runWithOwner(input.owner, () => {
      try {
        return persist(input.target, input.store)
      } catch (error) {
        // runWithOwner can hand this to Solid's error boundary and return undefined.
        cause = error
        throw error
      }
    })

    if (cache) return cache
  } catch (error) {
    cause ??= error
  }

  throw createChildStorePersistedCacheError({
    translate: input.translate,
    messageKey: input.messageKey,
    context,
    cause,
  })
}
