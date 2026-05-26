import { Cause, Effect, Layer, Scope, Context } from "effect"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { readdir } from "fs/promises"
import path from "path"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Git } from "@/git"
import { Instance } from "@/project/instance"
import { lazy } from "@/util/lazy"
import { Config } from "../config/config"
import { FileIgnore } from "./ignore"
import { Protected } from "./protected"
import { Log } from "@opencode-ai/core/util/log"

declare const OPENCODE_LIBC: string | undefined

export namespace FileWatcher {
  const log = Log.create({ service: "file.watcher" })
  const SUBSCRIBE_TIMEOUT_MS = 10_000
  const RESCAN_QUIET_MS = 1_000
  const WORKSPACE_IGNORE_ENTRIES = [".worktrees"]
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
    publish: (directory: string) => void
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
          input.publish(directory)
          settle(directory, state)
          return
        }
        pending.delete(directory)
        settle(directory, state)
      })
    }

    return {
      request(directory: string) {
        if (disposed) return
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
        }
        pending.set(directory, next)
        input.publish(directory)
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

            const subs: ParcelWatcher.AsyncSubscription[] = []
            yield* Effect.addFinalizer(() =>
              Effect.promise(() => Promise.allSettled(subs.map((sub) => sub.unsubscribe()))),
            )

            const requestRescan = createRescanScheduler({
              publish: (dir) => {
                log.warn("watcher events dropped, requesting rescan", { dir })
                Bus.publish(Event.Rescan, { directory: dir }).catch((error) =>
                  log.warn("failed to publish watcher rescan", { dir, error }),
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
              (dir: string, shouldPublish = (_file: string) => true): ParcelWatcher.SubscribeCallback =>
              (err, evts) =>
              Instance.restore(ctx, () => {
                if (err) {
                  if (isDroppedEventsError(err)) {
                    requestRescan.request(dir)
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

            const subscribe = (dir: string, ignore: string[], shouldPublish?: (file: string) => boolean) => {
              const pending = w.subscribe(dir, createCallback(dir, shouldPublish), { ignore, backend })
              return Effect.gen(function* () {
                const sub = yield* Effect.promise(() => pending)
                subs.push(sub)
              }).pipe(
                Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
                Effect.catchCause((cause) => {
                  log.error("failed to subscribe", { dir, cause: Cause.pretty(cause) })
                  pending.then((s) => s.unsubscribe()).catch(() => {})
                  return Effect.void
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
              yield* subscribe(
                ctx.directory,
                workspaceSubscription.ignore,
              )
            }

            if (ctx.project.vcs === "git") {
              const result = yield* git.run(["rev-parse", "--git-dir"], {
                cwd: ctx.project.worktree,
              })
              const vcsDir =
                result.exitCode === 0 ? path.resolve(ctx.project.worktree, result.text().trim()) : undefined
              if (vcsDir && !cfgIgnores.includes(".git") && !cfgIgnores.includes(vcsDir)) {
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
