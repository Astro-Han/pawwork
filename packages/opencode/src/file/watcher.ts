import { Cause, Effect, Layer, Scope, Context } from "effect"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { readdir, realpath, stat } from "fs/promises"
import path from "path"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Git } from "@/git"
import { Instance } from "@/project/instance"
import { lazy } from "@/util/lazy"
import { Glob } from "@/util/glob"
import { Config } from "../config/config"
import { FileIgnore } from "./ignore"
import { Protected } from "./protected"
import { Log } from "@opencode-ai/core/util/log"

declare const OPENCODE_LIBC: string | undefined

export namespace FileWatcher {
  const log = Log.create({ service: "file.watcher" })
  const SUBSCRIBE_TIMEOUT_MS = 10_000
  const RESCAN_QUIET_MS = 1_000
  const ROOT_DISCOVERY_INTERVAL_MS = 500
  const FALLBACK_RESCAN_INTERVAL_MS = 5_000
  export const MAX_WORKSPACE_WATCH_ROOTS = 128
  const LOCAL_ARTIFACT_ENTRIES = new Set([".worktrees", ".claude", ".claire", ".superpowers"])
  const WORKSPACE_IGNORE_ENTRIES = [...LOCAL_ARTIFACT_ENTRIES]
  const VCS_SUBSCRIBE_ENTRIES = new Set(["HEAD", "index", "packed-refs", "refs"])
  const VCS_REFRESH_FILES = new Set(["HEAD", "index", "packed-refs"])
  const VCS_REFRESH_PREFIXES = ["refs/heads/", "refs/remotes/"]

  export const Event = {
    Updated: BusEvent.define(
      "file.watcher.updated",
      z.object({
        file: z.string(),
        event: z.union([z.literal("add"), z.literal("change"), z.literal("unlink")]),
      }),
    ),
    Rescan: BusEvent.define(
      "file.watcher.rescan",
      z.object({
        directory: z.string(),
      }),
    ),
  }

  const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
    try {
      const binding = require(
        `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${OPENCODE_LIBC || "glibc"}` : ""}`,
      )
      return createWrapper(binding) as typeof import("@parcel/watcher")
    } catch (error) {
      log.error("failed to load watcher binding", { error })
      return
    }
  })

  function getBackend() {
    if (process.platform === "win32") return "windows"
    if (process.platform === "darwin") return "fs-events"
    if (process.platform === "linux") return "inotify"
  }

  function protecteds(dir: string) {
    return Protected.paths().filter((item) => {
      const rel = path.relative(dir, item)
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
    })
  }

  export const hasNativeBinding = () => !!watcher()

  export function isDroppedEventsError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return message.includes("Events were dropped") && message.includes("File system must be re-scanned")
  }

  export type WatchScope = "workspace" | "vcs"
  type RuntimeWatchScope = WatchScope | "workspace-child" | "root-discovery"
  export type RootEntryState = {
    name: string
    path: string
    type: WorkspaceWatchPlanEntry["type"]
    size: number
    mtimeMs: number
  }
  type RescanRequest = {
    directory: string
    subscriptionDirectory?: string
    watchScope?: RuntimeWatchScope
  }
  export type WatchPlanExcludeReason = "default-ignore" | "local-artifact" | "user-config" | "protected-path"
  export type WorkspaceWatchPlanEntry = { name: string; type: "directory" | "file" | "other" }
  export type WorkspaceWatchPlanRoot = {
    directory: string
    ignore: string[]
    reason: "workspace-child"
  }
  export type WorkspaceWatchPlanExcluded = {
    path: string
    reason: WatchPlanExcludeReason
  }
  export type WorkspaceWatchPlan = {
    roots: WorkspaceWatchPlanRoot[]
    excluded: WorkspaceWatchPlanExcluded[]
    rootFiles: string[]
    rootCount: number
    maxRootCount: number
    fallbackStrategy?: "limited-child-watchers"
    rootFilesStrategy: "poll-root-entries"
    refreshStrategy: "refresh-plan-on-top-level-entry-change"
  }
  export type RescanIncidentSummary = {
    directory: string
    request_count: number
    coalesced_count: number
    leading_published: boolean
    trailing_published: boolean
    quiet_ms: number
    duration_ms: number
  }

  export function createRescanScheduler(input: {
    publish: (request: RescanRequest) => void
    schedule?: (callback: () => void) => (() => void) | void
    now?: () => number
    onIncidentSettled?: (summary: RescanIncidentSummary) => void
  }) {
    type RescanState = {
      dirty: boolean
      needsTrailing: boolean
      cancel?: () => void
      startedAt: number
      requestCount: number
      leadingPublished: boolean
      trailingPublished: boolean
      request: RescanRequest
    }
    const pending = new Map<string, RescanState>()
    const schedule = (callback: () => void) => {
      const cancel = input.schedule?.(callback)
      if (cancel) return cancel
      const timer = setTimeout(callback, RESCAN_QUIET_MS)
      return () => clearTimeout(timer)
    }
    const now = () => input.now?.() ?? Date.now()
    let disposed = false

    const settle = (directory: string, state: RescanState) => {
      input.onIncidentSettled?.({
        directory,
        request_count: state.requestCount,
        coalesced_count: Math.max(0, state.requestCount - 1),
        leading_published: state.leadingPublished,
        trailing_published: state.trailingPublished,
        quiet_ms: RESCAN_QUIET_MS,
        duration_ms: Math.max(0, now() - state.startedAt),
      })
    }

    const arm = (directory: string, state: RescanState) => {
      state.cancel = schedule(() => {
        state.cancel = undefined
        if (disposed) return
        if (state.dirty) {
          state.dirty = false
          arm(directory, state)
          return
        }
        if (state.needsTrailing) {
          state.needsTrailing = false
          state.trailingPublished = true
          pending.delete(directory)
          input.publish(state.request)
          settle(directory, state)
          return
        }
        pending.delete(directory)
        settle(directory, state)
      })
    }

    return {
      request(inputRequest: string | RescanRequest) {
        if (disposed) return
        const request = typeof inputRequest === "string" ? { directory: inputRequest } : inputRequest
        const directory = request.directory
        const state = pending.get(directory)
        if (state) {
          state.dirty = true
          state.needsTrailing = true
          state.requestCount++
          return
        }

        const next: RescanState = {
          dirty: false,
          needsTrailing: false,
          startedAt: now(),
          requestCount: 1,
          leadingPublished: true,
          trailingPublished: false,
          request,
        }
        pending.set(directory, next)
        input.publish(request)
        arm(directory, next)
      },
      dispose() {
        disposed = true
        for (const state of pending.values()) {
          state.cancel?.()
        }
        pending.clear()
      },
    }
  }

  export function vcsWatcherIgnoreEntries(entries: string[]) {
    return entries.filter((entry) => !VCS_SUBSCRIBE_ENTRIES.has(entry))
  }

  export function workspaceWatcherIgnoreEntries(input: { config: string[]; protected: string[] }) {
    return [...new Set([...FileIgnore.PATTERNS, ...WORKSPACE_IGNORE_ENTRIES, ...input.config, ...input.protected])]
  }

  export function createFallbackRescanThrottle(input: { now?: () => number } = {}) {
    let active = false
    let lastRescan = 0
    return {
      now: input.now ?? (() => Date.now()),
      enter() {
        if (active) return false
        active = true
        lastRescan = this.now()
        return true
      },
      tick() {
        if (!active) return false
        const now = this.now()
        if (now - lastRescan < FALLBACK_RESCAN_INTERVAL_MS) return false
        lastRescan = now
        return true
      },
      exit() {
        active = false
      },
    }
  }

  function hasGlobSyntax(value: string) {
    return /[*?[\]{}]/.test(value)
  }

  function normalizePathKey(value: string) {
    return value.replaceAll("\\", "/").replace(/\/+$/, "")
  }

  function globTargetsRootEntry(pattern: string, entry: string) {
    if (!hasGlobSyntax(pattern)) return false
    return Glob.match(pattern, `${entry}/__pawwork_watch_plan_probe__`)
  }

  function ignoreReason(input: {
    entry: string
    fullPath: string
    ignore: string[]
    userConfig?: string[]
    protectedPaths?: string[]
  }): WatchPlanExcludeReason | undefined {
    const entryKey = normalizePathKey(input.entry)
    if (LOCAL_ARTIFACT_ENTRIES.has(entryKey)) return "local-artifact"

    const protectedSet = new Set(input.protectedPaths?.map((item) => normalizePathKey(item)) ?? [])
    if (protectedSet.has(normalizePathKey(input.fullPath)) || protectedSet.has(entryKey)) return "protected-path"

    const configSet = new Set(input.userConfig?.map((item) => normalizePathKey(item)) ?? [])
    if (configSet.has(entryKey) || configSet.has(normalizePathKey(input.fullPath))) return "user-config"
    if (input.userConfig?.some((item) => globTargetsRootEntry(normalizePathKey(item), entryKey))) return "user-config"

    if (
      input.ignore.some((item) => {
        const pattern = normalizePathKey(item)
        return (!hasGlobSyntax(pattern) && pattern === entryKey) || globTargetsRootEntry(pattern, entryKey)
      })
    )
      return "default-ignore"
    return undefined
  }

  function subscriptionGlobIgnoreEntry(input: { workspace: string; subscription: string; pattern: string }) {
    const pattern = normalizePathKey(input.pattern)
    if (!hasGlobSyntax(pattern)) return pattern
    if (pattern.startsWith("**/")) return pattern

    const subscription = normalizePathKey(path.relative(input.workspace, input.subscription))
    if (!subscription || subscription.startsWith("..") || path.isAbsolute(subscription)) return undefined
    if (!pattern.includes("/")) return undefined
    if (!pattern.startsWith(`${subscription}/`)) return undefined
    return pattern.slice(subscription.length + 1)
  }

  export function subscriptionIgnoreEntries(input: { workspace: string; subscription: string; ignore: string[] }) {
    return input.ignore.flatMap((entry) => {
      if (path.isAbsolute(entry)) return entry
      if (hasGlobSyntax(entry)) return subscriptionGlobIgnoreEntry({ ...input, pattern: entry }) ?? []
      return path.resolve(input.workspace, entry)
    })
  }

  export function workspaceWatchPlan(input: {
    directory: string
    backend: string
    entries: WorkspaceWatchPlanEntry[]
    ignore: string[]
    userConfig?: string[]
    protectedPaths?: string[]
  }): WorkspaceWatchPlan {
    const roots: WorkspaceWatchPlanRoot[] = []
    const excluded: WorkspaceWatchPlanExcluded[] = []
    const rootFiles: string[] = []

    for (const entry of input.entries) {
      const fullPath = path.join(input.directory, entry.name)
      const reason = ignoreReason({
        entry: entry.name,
        fullPath,
        ignore: input.ignore,
        userConfig: input.userConfig,
        protectedPaths: input.protectedPaths,
      })
      if (reason) {
        excluded.push({ path: fullPath, reason })
        continue
      }

      if (entry.type === "directory") {
        roots.push({
          directory: fullPath,
          ignore: subscriptionIgnoreEntries({
            workspace: input.directory,
            subscription: fullPath,
            ignore: input.ignore,
          }),
          reason: "workspace-child",
        })
        continue
      }

      if (entry.type === "file") rootFiles.push(fullPath)
    }

    const rootCount = roots.length
    const fallbackStrategy = rootCount > MAX_WORKSPACE_WATCH_ROOTS ? "limited-child-watchers" : undefined

    return {
      roots: fallbackStrategy ? roots.slice(0, MAX_WORKSPACE_WATCH_ROOTS) : roots,
      excluded,
      rootFiles,
      rootCount,
      maxRootCount: MAX_WORKSPACE_WATCH_ROOTS,
      fallbackStrategy,
      rootFilesStrategy: "poll-root-entries",
      refreshStrategy: "refresh-plan-on-top-level-entry-change",
    }
  }

  async function rootEntrySnapshot(directory: string) {
    const entries = new Map<string, RootEntryState>()
    const items = await readdir(directory, { withFileTypes: true })
    await Promise.all(
      items.map(async (item) => {
        const fullPath = path.join(directory, item.name)
        const type = item.isDirectory() ? "directory" : item.isFile() ? "file" : "other"
        const info = type === "file" ? await stat(fullPath).catch(() => undefined) : undefined
        entries.set(item.name, {
          name: item.name,
          path: fullPath,
          type,
          size: info?.size ?? 0,
          mtimeMs: info?.mtimeMs ?? 0,
        })
      }),
    )
    return entries
  }

  function watchPlanEntries(snapshot: Map<string, RootEntryState>): WorkspaceWatchPlanEntry[] {
    return [...snapshot.values()].map((item) => ({ name: item.name, type: item.type }))
  }

  function rootFileChanged(prev: RootEntryState | undefined, next: RootEntryState | undefined) {
    if (!prev || !next) return false
    return prev.type === "file" && next.type === "file" && (prev.size !== next.size || prev.mtimeMs !== next.mtimeMs)
  }

  function shouldPublishWorkspacePath(file: string, workspace: string, ignore: string[]) {
    const relative = path.relative(workspace, file)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false
    for (const entry of ignore) {
      if (!path.isAbsolute(entry) || hasGlobSyntax(entry)) continue
      const rel = path.relative(entry, file)
      if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) return false
    }
    return !FileIgnore.match(relative, { extra: ignore })
  }

  export async function runWorkspaceRootPoll(input: {
    previous: Map<string, RootEntryState>
    next: Map<string, RootEntryState>
    workspace: string
    ignore: string[]
    isDisposed: () => boolean
    applyPlan: (next: Map<string, RootEntryState>) => Promise<void>
    publishUpdate: (event: { file: string; event: "add" | "change" | "unlink" }) => void
    publishRescan: (directory: string) => void | Promise<void>
  }) {
    if (input.isDisposed()) return input.previous

    const nextNames = new Set(input.next.keys())
    let refreshPlan = false

    for (const [name, value] of input.next) {
      if (input.isDisposed()) return input.previous
      const before = input.previous.get(name)
      const publishable = shouldPublishWorkspacePath(value.path, input.workspace, input.ignore)
      if (!before) {
        if (value.type === "file" && publishable) input.publishUpdate({ file: value.path, event: "add" })
        if (value.type === "directory" && publishable) {
          refreshPlan = true
          input.publishUpdate({ file: value.path, event: "add" })
        }
        continue
      }
      if (rootFileChanged(before, value) && publishable) input.publishUpdate({ file: value.path, event: "change" })
      if (before.type !== value.type && publishable) refreshPlan = true
    }

    for (const [name, value] of input.previous) {
      if (input.isDisposed()) return input.previous
      if (nextNames.has(name)) continue
      const publishable = shouldPublishWorkspacePath(value.path, input.workspace, input.ignore)
      if (value.type === "file" && publishable) input.publishUpdate({ file: value.path, event: "unlink" })
      if (value.type === "directory" && publishable) {
        refreshPlan = true
        input.publishUpdate({ file: value.path, event: "unlink" })
      }
    }

    if (!refreshPlan) return input.next
    await input.applyPlan(input.next)
    if (input.isDisposed()) return input.previous
    await input.publishRescan(input.workspace)
    return input.next
  }

  export function watcherSubscriptionDiagnostics(input: {
    directory: string
    backend: string
    ignore: string[]
    scope: WatchScope
    vcsDir?: string
  }) {
    return {
      dir: input.directory,
      backend: input.backend,
      watch_scope: input.scope,
      ignore_count: input.ignore.length,
      ignores_worktrees: input.ignore.includes(".worktrees"),
      ...(input.vcsDir ? { vcs_dir: input.vcsDir } : {}),
    }
  }

  export function workspaceWatcherSubscription(input: {
    directory: string
    backend: string
    configIgnores: string[]
    protectedPaths: string[]
  }) {
    const ignore = workspaceWatcherIgnoreEntries({
      config: input.configIgnores,
      protected: input.protectedPaths,
    })
    return {
      ignore,
      diagnostics: watcherSubscriptionDiagnostics({
        directory: input.directory,
        backend: input.backend,
        ignore,
        scope: "workspace",
      }),
    }
  }

  export function shouldPublishVcsWatcherPath(file: string, vcsDir: string) {
    const relative = path.relative(vcsDir, file).replaceAll(path.sep, "/")
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false
    if (VCS_REFRESH_FILES.has(relative)) return true
    return VCS_REFRESH_PREFIXES.some((prefix) => relative.startsWith(prefix))
  }

  // Turn raw `git rev-parse --git-dir/--git-common-dir` lines into the canonical directories to
  // subscribe. Each line is resolved against `directory` (rev-parse may print relative paths like
  // ".git"), then realpath-canonicalized: a possibly-symlinked git dir (a symlinked .git, or a
  // worktree reached through a symlinked path such as macOS /tmp -> /private/tmp) makes parcel emit
  // events at the realpath, so an unresolved vcsDir makes path.relative in shouldPublishVcsWatcherPath
  // traverse out (..) and drop every HEAD/ref event. Fall back to the unresolved path when realpath
  // fails (dir may be absent). The `watcher.ignore` config skips a dir matched by either form, and
  // the result is deduped (--git-dir and --git-common-dir coincide in a normal repo).
  export async function resolveVcsWatchDirs(input: {
    directory: string
    gitDirs: string[]
    cfgIgnores: string[]
    resolveLink?: (target: string) => Promise<string>
  }): Promise<string[]> {
    const resolveLink = input.resolveLink ?? ((target) => realpath(target))
    const resolved = [
      ...new Set(
        input.gitDirs
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => path.resolve(input.directory, line)),
      ),
    ]
    const subscribed = new Set<string>()
    for (const resolvedVcsDir of resolved) {
      const vcsDir = await resolveLink(resolvedVcsDir).catch(() => resolvedVcsDir)
      if (input.cfgIgnores.includes(".git") || input.cfgIgnores.includes(resolvedVcsDir) || input.cfgIgnores.includes(vcsDir))
        continue
      subscribed.add(vcsDir)
    }
    return [...subscribed]
  }

  export interface Interface {
    readonly init: () => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/FileWatcher") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const git = yield* Git.Service

      const state = yield* InstanceState.make(
        Effect.fn("FileWatcher.state")(
          function* (ctx) {
            if (yield* Flag.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER) return

            log.info("init", { directory: ctx.directory })

            const backend = getBackend()
            if (!backend) {
              log.error("watcher backend not supported", { directory: ctx.directory, platform: process.platform })
              return
            }

            const w = watcher()
            if (!w) return

            log.info("watcher backend", { directory: ctx.directory, platform: process.platform, backend })

            const subs = new Set<ParcelWatcher.AsyncSubscription>()
            yield* Effect.addFinalizer(() =>
              Effect.promise(() => Promise.allSettled([...subs].map((sub) => sub.unsubscribe()))),
            )

            const requestRescan = createRescanScheduler({
              publish: (request) => {
                log.warn("watcher events dropped, requesting rescan", {
                  dir: request.directory,
                  rescan_directory: request.directory,
                  subscription_dir: request.subscriptionDirectory ?? request.directory,
                  watch_scope: request.watchScope,
                })
                Bus.publish(Event.Rescan, { directory: request.directory }).catch((error) =>
                  log.warn("failed to publish watcher rescan", { dir: request.directory, error }),
                )
              },
              onIncidentSettled: (summary) => {
                log.warn("watcher rescan incident settled", summary)
              },
              schedule: (callback) => {
                const timer = setTimeout(() => Instance.restore(ctx, callback), RESCAN_QUIET_MS)
                return () => clearTimeout(timer)
              },
            })
            yield* Effect.addFinalizer(() => Effect.sync(() => requestRescan.dispose()))
            const createCallback =
              (
                dir: string,
                shouldPublish = (_file: string) => true,
                options?: {
                  rescanDirectory?: string
                  watchScope?: RuntimeWatchScope
                  isDisposed?: () => boolean
                },
              ): ParcelWatcher.SubscribeCallback =>
              (err, evts) =>
              Instance.restore(ctx, () => {
                if (err) {
                  if (isDroppedEventsError(err)) {
                    requestRescan.request({
                      directory: options?.rescanDirectory ?? dir,
                      subscriptionDirectory: dir,
                      watchScope: options?.watchScope,
                    })
                    return
                  }
                  log.error("watcher callback error", { err })
                  return
                }
                for (const evt of evts) {
                  if (!shouldPublish(evt.path)) continue
                  if (evt.type === "create") Bus.publish(Event.Updated, { file: evt.path, event: "add" })
                  if (evt.type === "update") Bus.publish(Event.Updated, { file: evt.path, event: "change" })
                  if (evt.type === "delete") Bus.publish(Event.Updated, { file: evt.path, event: "unlink" })
                }
              })

            const subscribe = (
              dir: string,
              ignore: string[],
              shouldPublish?: (file: string) => boolean,
              options?: {
                rescanDirectory?: string
                watchScope?: RuntimeWatchScope
                isDisposed?: () => boolean
              },
            ) => {
              const pending = w.subscribe(dir, createCallback(dir, shouldPublish, options), { ignore, backend })
              return Effect.gen(function* () {
                const sub = yield* Effect.promise(() => pending)
                if (options?.isDisposed?.()) {
                  yield* Effect.promise(() => sub.unsubscribe().catch(() => undefined))
                  return undefined
                }
                subs.add(sub)
                return sub
              }).pipe(
                Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
                Effect.catchCause((cause) => {
                  log.error("failed to subscribe", { dir, cause: Cause.pretty(cause) })
                  pending.then((s) => s.unsubscribe()).catch(() => {})
                  return Effect.succeed(undefined)
                }),
              )
            }

            const cfg = yield* config.get()
            const cfgIgnores = cfg.watcher?.ignore ?? []

            if (yield* Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER) {
              const workspaceSubscription = workspaceWatcherSubscription({
                directory: ctx.directory,
                backend,
                configIgnores: cfgIgnores,
                protectedPaths: protecteds(ctx.directory),
              })
              log.info("watcher subscription configured", workspaceSubscription.diagnostics)
              if (backend === "fs-events") {
                let planVersion = 0
                let snapshot = yield* Effect.promise(() => rootEntrySnapshot(ctx.directory))
                const active = new Map<string, ParcelWatcher.AsyncSubscription>()
                let watchPlanDisposed = false
                const fallbackRescan = createFallbackRescanThrottle()
                const publishWorkspaceRescan = () =>
                  Bus.publish(Event.Rescan, { directory: ctx.directory }).catch((error) =>
                    log.warn("failed to publish watcher rescan", { dir: ctx.directory, error }),
                  )
                const applyPlan = Effect.fn("FileWatcher.applyWorkspaceWatchPlan")(function* (
                  planSnapshot: Map<string, RootEntryState>,
                ) {
                  if (watchPlanDisposed) return
                  const plan = workspaceWatchPlan({
                    directory: ctx.directory,
                    backend,
                    entries: watchPlanEntries(planSnapshot),
                    ignore: workspaceSubscription.ignore,
                    userConfig: cfgIgnores,
                    protectedPaths: protecteds(ctx.directory),
                  })
                  planVersion++
                  log.info("watcher plan configured", {
                    dir: ctx.directory,
                    backend,
                    watch_scope: "workspace",
                    plan_version: planVersion,
                    root_count: plan.rootCount,
                    subscribed_root_count: plan.roots.length,
                    max_root_count: plan.maxRootCount,
                    fallback_strategy: plan.fallbackStrategy,
                    excluded_count: plan.excluded.length,
                    root_files_strategy: plan.rootFilesStrategy,
                    refresh_strategy: plan.refreshStrategy,
                    excluded: plan.excluded.map((item) => ({
                      path: item.path,
                      reason: item.reason,
                    })),
                  })

                  if (plan.fallbackStrategy === "limited-child-watchers") {
                    if (fallbackRescan.enter()) yield* Effect.promise(publishWorkspaceRescan)
                  } else {
                    fallbackRescan.exit()
                  }

                  const nextRoots = new Set(plan.roots.map((root) => root.directory))
                  for (const [dir, sub] of active) {
                    if (nextRoots.has(dir)) continue
                    active.delete(dir)
                    subs.delete(sub)
                    yield* Effect.promise(() => sub.unsubscribe().catch(() => undefined))
                    log.info("watcher subscription removed", {
                      dir,
                      watch_scope: "workspace-child",
                      plan_version: planVersion,
                    })
                  }
                  for (const root of plan.roots) {
                    if (watchPlanDisposed) return
                    if (active.has(root.directory)) continue
                    log.info("watcher subscription configured", {
                      dir: root.directory,
                      backend,
                      watch_scope: "workspace-child",
                      plan_version: planVersion,
                      ignore_count: root.ignore.length,
                      rescan_directory: ctx.directory,
                    })
                    const sub = yield* subscribe(
                      root.directory,
                      root.ignore,
                      (file) => shouldPublishWorkspacePath(file, ctx.directory, workspaceSubscription.ignore),
                      {
                        rescanDirectory: ctx.directory,
                        watchScope: "workspace-child",
                        isDisposed: () => watchPlanDisposed,
                      },
                    )
                    if (!sub) continue
                    if (watchPlanDisposed) {
                      subs.delete(sub)
                      yield* Effect.promise(() => sub.unsubscribe().catch(() => undefined))
                      return
                    }
                    active.set(root.directory, sub)
                  }
                })

                yield* applyPlan(snapshot)
                let polling = false
                const timer = setInterval(() => {
                  if (polling || watchPlanDisposed) return
                  polling = true
                  Instance.restore(ctx, () => {
                    rootEntrySnapshot(ctx.directory)
                      .then((next) =>
                        runWorkspaceRootPoll({
                          previous: snapshot,
                          next,
                          workspace: ctx.directory,
                          ignore: workspaceSubscription.ignore,
                          isDisposed: () => watchPlanDisposed,
                          applyPlan: (planSnapshot) => Effect.runPromise(applyPlan(planSnapshot)),
                          publishUpdate: (event) => {
                            Bus.publish(Event.Updated, event)
                          },
                          publishRescan: (directory) =>
                            Bus.publish(Event.Rescan, { directory }).catch((error) =>
                              log.warn("failed to publish watcher rescan", { dir: directory, error }),
                            ),
                        }),
                      )
                      .then((next) => {
                        snapshot = next
                        if (watchPlanDisposed || !fallbackRescan.tick()) return
                        return publishWorkspaceRescan()
                      })
                      .catch((error) => log.warn("failed to poll workspace root", { dir: ctx.directory, error }))
                      .finally(() => {
                        polling = false
                      })
                  })
                }, ROOT_DISCOVERY_INTERVAL_MS)
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    watchPlanDisposed = true
                    clearInterval(timer)
                  }),
                )
              } else {
                yield* subscribe(ctx.directory, workspaceSubscription.ignore)
              }
            }

            if (ctx.project.vcs === "git") {
              // Resolve git metadata roots from ctx.directory (the active session dir), the same
              // anchor Vcs.state reads the branch from. ctx.project.worktree points at the MAIN
              // repository for a linked worktree, so its .git/HEAD never changes on a per-worktree
              // checkout. A linked worktree keeps HEAD/index in the per-worktree --git-dir while
              // packed-refs/refs live in the shared --git-common-dir; watch both so branch and ref
              // events fire. They coincide in a normal repo, so dedupe to a single subscription.
              // rev-parse may print relative paths (e.g. ".git"); resolveVcsWatchDirs resolves each
              // against ctx.directory (rather than depending on --path-format=absolute, Git 2.31+),
              // realpath-canonicalizes symlinked git dirs, applies watcher.ignore, and dedupes.
              const result = yield* git.run(["rev-parse", "--git-dir", "--git-common-dir"], {
                cwd: ctx.directory,
              })
              const vcsDirs =
                result.exitCode === 0
                  ? yield* Effect.promise(() =>
                      resolveVcsWatchDirs({
                        directory: ctx.directory,
                        gitDirs: result.text().trim().split("\n"),
                        cfgIgnores,
                      }),
                    )
                  : []
              for (const vcsDir of vcsDirs) {
                const ignore = vcsWatcherIgnoreEntries(yield* Effect.promise(() => readdir(vcsDir).catch(() => [])))
                log.info(
                  "watcher subscription configured",
                  watcherSubscriptionDiagnostics({
                    directory: vcsDir,
                    backend,
                    ignore,
                    scope: "vcs",
                    vcsDir,
                  }),
                )
                yield* subscribe(vcsDir, ignore, (file) => shouldPublishVcsWatcherPath(file, vcsDir))
              }
            }
          },
          Effect.catchCause((cause) => {
            log.error("failed to init watcher service", { cause: Cause.pretty(cause) })
            return Effect.void
          }),
        ),
      )

      return Service.of({
        init: Effect.fn("FileWatcher.init")(function* () {
          yield* InstanceState.get(state)
        }),
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(Git.defaultLayer))
}
