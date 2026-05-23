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
  const RESCAN_DEDUPE_MS = 1_000

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

  export function createRescanScheduler(input: {
    publish: (directory: string) => void
    schedule?: (callback: () => void) => void
  }) {
    const pending = new Map<string, { dirty: boolean }>()
    const schedule = input.schedule ?? ((callback: () => void) => setTimeout(callback, RESCAN_DEDUPE_MS))

    const arm = (directory: string, state: { dirty: boolean }) => {
      schedule(() => {
        if (state.dirty) {
          state.dirty = false
          input.publish(directory)
          arm(directory, state)
          return
        }
        pending.delete(directory)
      })
    }

    return (directory: string) => {
      const state = pending.get(directory)
      if (state) {
        state.dirty = true
        return
      }

      const next = { dirty: false }
      pending.set(directory, next)
      input.publish(directory)
      arm(directory, next)
    }
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
              schedule: (callback) => {
                setTimeout(() => Instance.restore(ctx, callback), RESCAN_DEDUPE_MS)
              },
            })
            const createCallback = (dir: string): ParcelWatcher.SubscribeCallback => (err, evts) =>
              Instance.restore(ctx, () => {
                if (err) {
                  if (isDroppedEventsError(err)) {
                    requestRescan(dir)
                    return
                  }
                  log.error("watcher callback error", { err })
                  return
                }
                for (const evt of evts) {
                  if (evt.type === "create") Bus.publish(Event.Updated, { file: evt.path, event: "add" })
                  if (evt.type === "update") Bus.publish(Event.Updated, { file: evt.path, event: "change" })
                  if (evt.type === "delete") Bus.publish(Event.Updated, { file: evt.path, event: "unlink" })
                }
              })

            const subscribe = (dir: string, ignore: string[]) => {
              const pending = w.subscribe(dir, createCallback(dir), { ignore, backend })
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
              yield* subscribe(ctx.directory, [
                ...FileIgnore.PATTERNS,
                ...cfgIgnores,
                ...protecteds(ctx.directory),
              ])
            }

            if (ctx.project.vcs === "git") {
              const result = yield* git.run(["rev-parse", "--git-dir"], {
                cwd: ctx.project.worktree,
              })
              const vcsDir =
                result.exitCode === 0 ? path.resolve(ctx.project.worktree, result.text().trim()) : undefined
              if (vcsDir && !cfgIgnores.includes(".git") && !cfgIgnores.includes(vcsDir)) {
                const ignore = (yield* Effect.promise(() => readdir(vcsDir).catch(() => []))).filter(
                  (entry) => entry !== "HEAD",
                )
                yield* subscribe(vcsDir, ignore)
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
