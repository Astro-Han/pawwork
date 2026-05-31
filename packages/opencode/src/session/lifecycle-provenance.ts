import { createHash } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import type { LifecycleKind } from "./run-observability/types"

export type LifecycleOrigin = {
  source: "server_handler" | "config" | "cli" | "runtime" | "unknown"
  operation?: string
  reason?: string
}

export type LifecycleClientAction = {
  id: string
  kind?: string
  route_session_id?: string
  visible_session_id?: string
}

export type LifecycleRequest = {
  method: string
  path: string
  source: "renderer" | "local_api" | "remote_forwarded" | "unknown"
  directory_key?: string
  workspace_id?: string
  client_action?: LifecycleClientAction
}

export type LifecycleCloseAction = {
  actionID: string
  kind: LifecycleKind
  initiatedAt: number
  initiatedMonotonicMs: number
  affectedDirectoryKeys: readonly string[]
  origin?: Readonly<LifecycleOrigin>
  request?: Readonly<LifecycleRequest>
}

export type CreateLifecycleCloseActionOptions = {
  affectedDirectories?: string[]
  origin?: LifecycleOrigin
  request?: LifecycleRequest
}

let nextActionID = 0
const activeByDirectory = new Map<string, LifecycleCloseAction[]>()
const originContext = new AsyncLocalStorage<LifecycleOrigin>()
const activeRunsByDirectory = new Map<string, number>()
const idleWaiters = new Set<{ directories: readonly string[]; resolve: () => void }>()
const closingByDirectory = new Map<string, number>()
const closeWaiters = new Set<{ directory: string; resolve: (release: () => void) => void }>()

export function directoryKey(directory: string): string {
  const digest = createHash("sha256").update(directory).digest("hex").slice(0, 16)
  return `dir:${digest}`
}

export function createLifecycleCloseAction(
  kind: LifecycleKind,
  options: CreateLifecycleCloseActionOptions = {},
): LifecycleCloseAction {
  nextActionID += 1
  return {
    actionID: `lifecycle:${kind}:${Date.now().toString(36)}:${nextActionID.toString(36)}`,
    kind,
    initiatedAt: Date.now(),
    initiatedMonotonicMs: performance.now(),
    affectedDirectoryKeys: Object.freeze([...new Set(options.affectedDirectories?.map(directoryKey) ?? [])]),
    origin: options.origin ? Object.freeze({ ...options.origin }) : undefined,
    request: options.request ? freezeRequest(options.request) : undefined,
  }
}

export function lifecycleCloseActionMeta(action: LifecycleCloseAction) {
  return {
    lifecycleActionID: action.actionID,
    lifecycleKind: action.kind,
    lifecycleInitiatedAt: action.initiatedAt,
    lifecycleInitiatedMonotonicMs: action.initiatedMonotonicMs,
    lifecycleAffectedDirectoryKeys: [...action.affectedDirectoryKeys],
    lifecycleOrigin: action.origin ? { ...action.origin } : undefined,
    lifecycleRequest: action.request ? cloneRequest(action.request) : undefined,
  }
}

export function cloneRequest(request: Readonly<LifecycleRequest>): LifecycleRequest {
  return {
    ...request,
    client_action: request.client_action ? { ...request.client_action } : undefined,
  }
}

function freezeRequest(request: LifecycleRequest): Readonly<LifecycleRequest> {
  const client_action = request.client_action ? Object.freeze({ ...request.client_action }) : undefined
  return Object.freeze({ ...request, client_action })
}

export async function withLifecycleCloseAction<T>(
  directories: string[],
  action: LifecycleCloseAction,
  fn: () => Promise<T>,
): Promise<T> {
  for (const directory of directories) {
    const stack = activeByDirectory.get(directory) ?? []
    stack.push(action)
    activeByDirectory.set(directory, stack)
  }
  try {
    return await fn()
  } finally {
    for (const directory of directories) {
      const stack = activeByDirectory.get(directory)
      if (!stack) continue
      const index = stack.lastIndexOf(action)
      if (index >= 0) stack.splice(index, 1)
      if (stack.length) activeByDirectory.set(directory, stack)
      else activeByDirectory.delete(directory)
    }
  }
}

export function currentLifecycleCloseAction(directory: string): LifecycleCloseAction | undefined {
  return activeByDirectory.get(directory)?.at(-1)
}

export function currentLifecycleOrigin(): LifecycleOrigin | undefined {
  const origin = originContext.getStore()
  return origin ? { ...origin } : undefined
}

export async function withLifecycleOrigin<T>(origin: LifecycleOrigin, fn: () => Promise<T>): Promise<T> {
  return originContext.run({ ...origin }, fn)
}

function notifyIdleWaiters() {
  for (const waiter of [...idleWaiters]) {
    if (hasActiveRuns(waiter.directories)) continue
    idleWaiters.delete(waiter)
    waiter.resolve()
  }
}

function hasLifecycleClose(directories: readonly string[]): boolean {
  return directories.some((directory) => (closingByDirectory.get(directory) ?? 0) > 0)
}

export function isLifecycleClosing(directory: string): boolean {
  return (closingByDirectory.get(directory) ?? 0) > 0
}

function notifyCloseWaiters() {
  for (const waiter of [...closeWaiters]) {
    if (hasLifecycleClose([waiter.directory])) continue
    closeWaiters.delete(waiter)
    waiter.resolve(acquireActiveRun(waiter.directory))
  }
}

function acquireActiveRun(directory: string): () => void {
  activeRunsByDirectory.set(directory, (activeRunsByDirectory.get(directory) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const next = (activeRunsByDirectory.get(directory) ?? 1) - 1
    if (next > 0) activeRunsByDirectory.set(directory, next)
    else activeRunsByDirectory.delete(directory)
    notifyIdleWaiters()
  }
}

export type ActiveRunLifecycleWait = {
  reason: "lifecycle_close"
  startedAt: number
  startedMonotonicMs: number
  lifecycle?: ReturnType<typeof lifecycleCloseActionMeta>
}

export function trackActiveRun(directory: string): {
  promise: Promise<() => void>
  cancel: () => void
  wait?: ActiveRunLifecycleWait
} {
  if (!hasLifecycleClose([directory])) {
    return { promise: Promise.resolve(acquireActiveRun(directory)), cancel: () => {} }
  }
  const action = currentLifecycleCloseAction(directory)
  const wait: ActiveRunLifecycleWait = {
    reason: "lifecycle_close",
    startedAt: Date.now(),
    startedMonotonicMs: performance.now(),
    lifecycle: action ? lifecycleCloseActionMeta(action) : undefined,
  }
  let settled = false
  let waiter: { directory: string; resolve: (release: () => void) => void }
  const promise = new Promise<() => void>((resolve) => {
    waiter = {
      directory,
      resolve: (release: () => void) => {
        settled = true
        resolve(release)
      },
    }
    closeWaiters.add(waiter)
  })
  return {
    promise,
    wait,
    cancel: () => {
      if (settled) return
      settled = true
      closeWaiters.delete(waiter)
    },
  }
}

export function hasActiveRuns(directories: readonly string[]): boolean {
  return directories.some((directory) => (activeRunsByDirectory.get(directory) ?? 0) > 0)
}

export function whenAllRunsIdle(directories: readonly string[]): Promise<void> {
  const uniqueDirectories = [...new Set(directories)]
  if (!hasActiveRuns(uniqueDirectories)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    idleWaiters.add({ directories: uniqueDirectories, resolve })
  })
}

export function beginLifecycleClose(directories: readonly string[]): () => void {
  const uniqueDirectories = [...new Set(directories)]
  for (const directory of uniqueDirectories) {
    closingByDirectory.set(directory, (closingByDirectory.get(directory) ?? 0) + 1)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    for (const directory of uniqueDirectories) {
      const next = (closingByDirectory.get(directory) ?? 1) - 1
      if (next > 0) closingByDirectory.set(directory, next)
      else closingByDirectory.delete(directory)
    }
    notifyCloseWaiters()
  }
}
