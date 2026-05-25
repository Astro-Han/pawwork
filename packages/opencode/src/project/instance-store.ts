import { GlobalBus } from "@/bus/global"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { Filesystem } from "@/util/filesystem"
import { Log } from "@opencode-ai/core/util/log"
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import { InstanceBootstrap } from "./bootstrap-service"
import { type InstanceContext } from "./instance-context"
import { Project } from "./project"
import { State } from "./state"
import {
  beginLifecycleClose,
  createLifecycleCloseAction,
  currentLifecycleOrigin,
  directoryKey,
  hasActiveRuns,
  type LifecycleCloseAction,
  withLifecycleCloseAction,
  whenAllRunsIdle,
} from "@/session/lifecycle-provenance"
import { currentRequestContext } from "@/server/request-context"
import fs from "node:fs"
import path from "node:path"

const log = Log.create({ service: "instance.store" })

export interface LoadInput {
  directory: string
  worktree?: string | undefined
  project?: Project.Info | undefined
}

type ContextMismatchReason =
  | "worktree_mismatch"
  | "project_id_mismatch"
  | "project_row_missing"
  | "project_vcs_changed"
  | "explicit_context_changed"
  | "unknown_context_mismatch"

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext, unknown>
  readonly reload: (
    input: LoadInput,
    reason?: ContextMismatchReason | "reload",
    options?: LifecycleCloseOptions,
  ) => Effect.Effect<InstanceContext, unknown>
  readonly dispose: (ctx: InstanceContext, options?: LifecycleCloseOptions) => Effect.Effect<boolean>
  readonly disposeDirectory: (directory: string, options?: LifecycleCloseOptions) => Effect.Effect<boolean>
  readonly disposeAll: (options?: LifecycleCloseOptions) => Effect.Effect<LifecycleCloseResult>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | unknown, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

type Entry = {
  readonly deferred: Deferred.Deferred<InstanceContext, unknown>
}

export type LifecycleCloseMode = "maintenance" | "force"

export type LifecycleCloseOptions = {
  readonly mode?: LifecycleCloseMode
  readonly onCompleted?: () => void | Promise<void>
}

export type LifecycleCloseResult = {
  readonly status: "completed" | "deferred"
  readonly lifecycleActionID: string
  readonly affectedDirectoryKeys: readonly string[]
  readonly completed?: Promise<void>
}

const disposeLoadedInstances = new Set<(options?: LifecycleCloseOptions) => Promise<LifecycleCloseResult>>()

export async function disposeAllLoadedInstances(options?: LifecycleCloseOptions): Promise<LifecycleCloseResult> {
  const storeOptions = options?.onCompleted ? { ...options, onCompleted: undefined } : options
  const results = await Promise.all([...disposeLoadedInstances].map((dispose) => dispose(storeOptions)))
  const completeAggregate = async () => {
    await options?.onCompleted?.()
  }
  if (results.length === 0) {
    await completeAggregate()
    return {
      status: "completed",
      lifecycleActionID: "lifecycle:instance_dispose_all:empty",
      affectedDirectoryKeys: [],
    }
  }
  const status = results.some((result) => result.status === "deferred") ? "deferred" : "completed"
  const result: LifecycleCloseResult = {
    status,
    lifecycleActionID: results[0].lifecycleActionID,
    affectedDirectoryKeys: [...new Set(results.flatMap((entry) => entry.affectedDirectoryKeys))],
  }
  const completions = results.flatMap((entry) => (entry.completed ? [entry.completed] : []))
  const completed = Promise.all(completions).then(() => completeAggregate())
  if (status === "deferred") {
    void completed.catch(() => undefined)
    Object.defineProperty(result, "completed", {
      value: completed,
      enumerable: false,
    })
  } else {
    await completed
  }
  return result
}

function hasExplicitContext(input: LoadInput) {
  return input.worktree !== undefined || input.project !== undefined
}

function validateExplicitContext(input: LoadInput) {
  if ((input.worktree === undefined) !== (input.project === undefined)) {
    throw new Error("Instance worktree and project must be provided together")
  }
}

function contextMismatchReason(ctx: InstanceContext, input: LoadInput): ContextMismatchReason | undefined {
  if (!hasExplicitContext(input)) return undefined
  const worktreeChanged = ctx.worktree !== input.worktree
  const projectChanged = ctx.project.id !== input.project?.id
  if (worktreeChanged && projectChanged) return "explicit_context_changed"
  if (worktreeChanged) return "worktree_mismatch"
  if (projectChanged) return "project_id_mismatch"
  return undefined
}

function hasGitMarker(directory: string) {
  let current = directory
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return true
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const scope = yield* Scope.Scope
    const entries = new Map<string, Entry>()

    const boot = (input: LoadInput & { directory: string }): Effect.Effect<InstanceContext, unknown> =>
      Effect.gen(function* () {
        validateExplicitContext(input)

        const ctx =
          input.project && input.worktree
            ? {
                directory: input.directory,
                worktree: input.worktree,
                project: input.project,
              }
            : yield* project.fromDirectory(input.directory).pipe(
                Effect.map(({ project, sandbox }) => ({
                  directory: input.directory,
                  worktree: sandbox,
                  project,
                })),
              )

        yield* bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx))
        return ctx
      }).pipe(Effect.withSpan("InstanceStore.boot"))

    const removeEntry = (directory: string, entry: Entry) =>
      Effect.sync(() => {
        if (entries.get(directory) !== entry) return false
        entries.delete(directory)
        return true
      })

    const completeLoad = (directory: string, input: LoadInput, entry: Entry) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(boot({ ...input, directory }))
        if (Exit.isFailure(exit)) yield* removeEntry(directory, entry)
        yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
      })

    const emitDisposed = (ctx: InstanceContext) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: ctx.directory,
          project: ctx.project.id,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: ctx.directory,
            },
          },
        }),
      )

    const lifecycleContext = (operation: string, reason: string) => {
      const request = currentRequestContext()
      const explicitOrigin = currentLifecycleOrigin()
      if (explicitOrigin) return { origin: explicitOrigin, ...(request ? { request } : {}) }
      return request
        ? {
            origin: { source: "server_handler" as const, operation, reason: request.client_action?.kind ?? reason },
            request,
          }
        : { origin: { source: "runtime" as const, operation, reason } }
    }

    const disposeContext = (ctx: InstanceContext, action?: LifecycleCloseAction) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const closeAction =
            action ??
            createLifecycleCloseAction("instance_dispose", {
              affectedDirectories: [ctx.directory],
              ...lifecycleContext("instance.dispose", "dispose_context"),
            })
          await withLifecycleCloseAction([ctx.directory], closeAction, async () => {
            await State.dispose(ctx.directory)
            await runDisposers(ctx.directory)
          })
        })
        yield* emitDisposed(ctx)
      })

    const completeLifecycleClose = (options?: LifecycleCloseOptions) =>
      Effect.promise(() => Promise.resolve(options?.onCompleted?.()))

    const reportDeferredFailure = (
      operation: "disposeAll" | "disposeEntry" | "reload",
      directory: string | undefined,
      action: LifecycleCloseAction,
      error: unknown,
    ) =>
      log.error("deferred lifecycle close failed", {
        operation,
        directoryKey: directory ? directoryKey(directory) : undefined,
        lifecycleAffectedDirectoryKeys: [...action.affectedDirectoryKeys],
        lifecycleActionID: action.actionID,
        lifecycleKind: action.kind,
        error,
      })

    const disposeEntryNow = (
      directory: string,
      entry: Entry,
      ctx: InstanceContext,
      closeAction: LifecycleCloseAction,
      options?: LifecycleCloseOptions,
    ) =>
      Effect.gen(function* () {
        if (entries.get(directory) !== entry) return false
        yield* disposeContext(ctx, closeAction)
        if (entries.get(directory) !== entry) return false
        entries.delete(directory)
        yield* completeLifecycleClose(options)
        return true
      })

    const disposeEntry = (
      directory: string,
      entry: Entry,
      ctx: InstanceContext,
      action?: LifecycleCloseAction,
      options?: LifecycleCloseOptions,
    ) =>
      Effect.gen(function* () {
        const closeAction =
          action ??
          createLifecycleCloseAction("instance_dispose", {
            affectedDirectories: [ctx.directory],
            ...lifecycleContext("instance.dispose", "dispose_context"),
          })
        if ((options?.mode ?? "maintenance") !== "maintenance") {
          return yield* disposeEntryNow(directory, entry, ctx, closeAction, options)
        }

        const releaseClose = beginLifecycleClose([ctx.directory])
        if (hasActiveRuns([ctx.directory])) {
          const completed = whenAllRunsIdle([ctx.directory])
            .then(() => Effect.runPromise(disposeEntryNow(directory, entry, ctx, closeAction, options)))
            .catch((error) => reportDeferredFailure("disposeEntry", ctx.directory, closeAction, error))
            .finally(releaseClose)
            .then(() => undefined)
          void completed
          return false
        }
        try {
          return yield* disposeEntryNow(directory, entry, ctx, closeAction, options)
        } finally {
          releaseClose()
        }
      })

    const reload = (
      input: LoadInput,
      reason: ContextMismatchReason | "reload" = "reload",
      options?: LifecycleCloseOptions,
    ): Effect.Effect<InstanceContext, unknown> => {
      const directory = Filesystem.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          validateExplicitContext(input)
          const previous = entries.get(directory)
          let releaseClose: (() => void) | undefined
          if ((options?.mode ?? "maintenance") === "maintenance" && previous) {
            releaseClose = beginLifecycleClose([directory])
            const exit = yield* restore(Deferred.await(previous.deferred)).pipe(Effect.exit)
            if (Exit.isSuccess(exit) && hasActiveRuns([exit.value.directory])) {
              const releaseDeferredClose = releaseClose
              const deferredAction = createLifecycleCloseAction("instance_reload", {
                affectedDirectories: [exit.value.directory],
                ...lifecycleContext("instance.reload", reason),
              })
              void whenAllRunsIdle([exit.value.directory])
                .then(() => Effect.runPromise(reload(input, reason, { mode: "force" })))
                .catch((error) => reportDeferredFailure("reload", exit.value.directory, deferredAction, error))
                .finally(releaseDeferredClose)
                .then(() => undefined)
              return exit.value
            }
          }
          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext, unknown>() }
          entries.set(directory, entry)
          yield* Effect.gen(function* () {
            if (previous) {
              const exit = yield* Deferred.await(previous.deferred).pipe(Effect.exit)
              if (Exit.isSuccess(exit))
                yield* disposeContext(
                  exit.value,
                  createLifecycleCloseAction("instance_reload", {
                    affectedDirectories: [exit.value.directory],
                    ...lifecycleContext("instance.reload", reason),
                  }),
                )
              else yield* removeEntry(directory, previous)
            }
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          try {
            return yield* restore(Deferred.await(entry.deferred))
          } finally {
            releaseClose?.()
          }
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    }

    const load = (input: LoadInput): Effect.Effect<InstanceContext, unknown> => {
      const directory = Filesystem.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          validateExplicitContext(input)
          const existing = entries.get(directory)
          if (existing) {
            const exit = yield* restore(Deferred.await(existing.deferred)).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const mismatchReason = contextMismatchReason(exit.value, input)
              if (!mismatchReason) {
                const row = yield* project.get(exit.value.project.id)
                if (!row) return yield* reload(input, "project_row_missing")
                if (exit.value.project.vcs !== "git" && hasGitMarker(directory)) {
                  const next = yield* project.fromDirectory(directory)
                  if (next.project.vcs === "git")
                    return yield* reload(
                      {
                        directory,
                        worktree: next.sandbox,
                        project: next.project,
                      },
                      "project_vcs_changed",
                    )
                }
                return exit.value
              }
              return yield* reload(input, mismatchReason)
            }
            return yield* reload(input, "unknown_context_mismatch")
          }

          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext, unknown>() }
          entries.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.load"))
    }

    const dispose = (ctx: InstanceContext, options?: LifecycleCloseOptions) =>
      Effect.gen(function* () {
        const directory = Filesystem.resolve(ctx.directory)
        const entry = entries.get(directory)
        if (!entry) {
          yield* disposeContext(ctx)
          return true
        }

        const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
        if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry)
        if (exit.value !== ctx) return false
        return yield* disposeEntry(
          directory,
          entry,
          ctx,
          createLifecycleCloseAction("instance_dispose", {
            affectedDirectories: [ctx.directory],
            ...lifecycleContext("instance.dispose", "dispose"),
          }),
          options,
        )
      })

    const disposeDirectory = (inputDirectory: string, options?: LifecycleCloseOptions) =>
      Effect.gen(function* () {
        const directory = Filesystem.resolve(inputDirectory)
        const entry = entries.get(directory)
        if (!entry) return false

        const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
        if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry)
        return yield* disposeEntry(
          directory,
          entry,
          exit.value,
          createLifecycleCloseAction("instance_dispose_directory", {
            affectedDirectories: [exit.value.directory],
            ...lifecycleContext("instance.disposeDirectory", "dispose_directory"),
          }),
          options,
        )
      })

    const closeAllEntries = (action: LifecycleCloseAction, options?: LifecycleCloseOptions) =>
      Effect.forEach(
        [...entries.entries()],
        ([directory, entry]) =>
          Effect.gen(function* () {
            const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              yield* removeEntry(directory, entry)
              return
            }
            yield* disposeEntry(directory, entry, exit.value, action, options)
          }),
        { discard: true },
      )

    const resultFor = (
      status: LifecycleCloseResult["status"],
      action: LifecycleCloseAction,
      completed?: Promise<void>,
    ): LifecycleCloseResult => {
      const result: LifecycleCloseResult = {
        status,
        lifecycleActionID: action.actionID,
        affectedDirectoryKeys: [...action.affectedDirectoryKeys],
      }
      if (completed) Object.defineProperty(result, "completed", { value: completed, enumerable: false })
      return result
    }

    const disposeAllOnce = (options?: LifecycleCloseOptions) =>
      Effect.gen(function* () {
        const activeDirectories = [...entries.keys()]
        const action = createLifecycleCloseAction("instance_dispose_all", {
          affectedDirectories: activeDirectories,
          ...lifecycleContext("instance.disposeAll", "dispose_all"),
        })
        const entryOptions = { ...options, onCompleted: undefined }
        const close = closeAllEntries(action, entryOptions).pipe(Effect.andThen(completeLifecycleClose(options)))
        if ((options?.mode ?? "maintenance") === "maintenance") {
          const releaseClose = beginLifecycleClose(activeDirectories)
          if (hasActiveRuns(activeDirectories)) {
            const completed = whenAllRunsIdle(activeDirectories)
              .then(() => Effect.runPromise(close))
              .catch((error) => {
                reportDeferredFailure("disposeAll", undefined, action, error)
                throw error
              })
              .finally(releaseClose)
            void completed.catch(() => undefined)
            return resultFor("deferred", action, completed)
          }
          try {
            yield* close
          } finally {
            releaseClose()
          }
          return resultFor("completed", action)
        }
        yield* close
        return resultFor("completed", action)
      })

    const disposeAll = (options?: LifecycleCloseOptions) => disposeAllOnce(options)

    const disposeAllPromise = (options?: LifecycleCloseOptions) => Effect.runPromise(disposeAll(options))
    yield* Effect.sync(() => {
      disposeLoadedInstances.add(disposeAllPromise)
    })
    yield* Effect.addFinalizer(() =>
      disposeAll({ mode: "force" }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            disposeLoadedInstances.delete(disposeAllPromise)
          }),
        ),
      ),
    )

    return {
      load,
      reload,
      dispose,
      disposeDirectory,
      disposeAll,
      provide: (input, effect) =>
        load(input).pipe(Effect.flatMap((ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx)))),
    }
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Project.defaultLayer))

export * as InstanceStore from "./instance-store"
