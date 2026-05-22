import { GlobalBus } from "@/bus/global"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { Filesystem } from "@/util/filesystem"
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import { InstanceBootstrap } from "./bootstrap-service"
import { type InstanceContext } from "./instance-context"
import { Project } from "./project"
import { State } from "./state"
import {
  createLifecycleCloseAction,
  currentLifecycleOrigin,
  type LifecycleCloseAction,
  withLifecycleCloseAction,
} from "@/session/lifecycle-provenance"
import { currentRequestContext } from "@/server/request-context"

export interface LoadInput {
  directory: string
  worktree?: string | undefined
  project?: Project.Info | undefined
}

type ContextMismatchReason =
  | "worktree_mismatch"
  | "project_id_mismatch"
  | "project_row_missing"
  | "explicit_context_changed"
  | "unknown_context_mismatch"

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext, unknown>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext, unknown>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | unknown, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

type Entry = {
  readonly deferred: Deferred.Deferred<InstanceContext, unknown>
}

const disposeLoadedInstances = new Set<() => Promise<void>>()

export async function disposeAllLoadedInstances() {
  await Promise.all([...disposeLoadedInstances].map((dispose) => dispose()))
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

    const disposeEntry = (directory: string, entry: Entry, ctx: InstanceContext, action?: LifecycleCloseAction) =>
      Effect.gen(function* () {
        if (entries.get(directory) !== entry) return false
        yield* disposeContext(ctx, action)
        if (entries.get(directory) !== entry) return false
        entries.delete(directory)
        return true
      })

    const reload = (
      input: LoadInput,
      reason: ContextMismatchReason | "reload" = "reload",
    ): Effect.Effect<InstanceContext, unknown> => {
      const directory = Filesystem.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          validateExplicitContext(input)
          const previous = entries.get(directory)
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
          return yield* restore(Deferred.await(entry.deferred))
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
                if (row) return exit.value
                return yield* reload(input, "project_row_missing")
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

    const dispose = (ctx: InstanceContext) =>
      Effect.gen(function* () {
        const directory = Filesystem.resolve(ctx.directory)
        const entry = entries.get(directory)
        if (!entry) return yield* disposeContext(ctx)

        const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
        if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry).pipe(Effect.asVoid)
        if (exit.value !== ctx) return
        yield* disposeEntry(
          directory,
          entry,
          ctx,
          createLifecycleCloseAction("instance_dispose", {
            affectedDirectories: [ctx.directory],
            ...lifecycleContext("instance.dispose", "dispose"),
          }),
        ).pipe(Effect.asVoid)
      })

    const disposeDirectory = (inputDirectory: string) =>
      Effect.gen(function* () {
        const directory = Filesystem.resolve(inputDirectory)
        const entry = entries.get(directory)
        if (!entry) return

        const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
        if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry).pipe(Effect.asVoid)
        yield* disposeEntry(
          directory,
          entry,
          exit.value,
          createLifecycleCloseAction("instance_dispose_directory", {
            affectedDirectories: [exit.value.directory],
            ...lifecycleContext("instance.disposeDirectory", "dispose_directory"),
          }),
        ).pipe(Effect.asVoid)
      })

    const disposeAllOnce = Effect.gen(function* () {
      const activeDirectories = [...entries.keys()]
      const action = createLifecycleCloseAction("instance_dispose_all", {
        affectedDirectories: activeDirectories,
        ...lifecycleContext("instance.disposeAll", "dispose_all"),
      })
      yield* Effect.forEach(
        [...entries.entries()],
        ([directory, entry]) =>
          Effect.gen(function* () {
            const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              yield* removeEntry(directory, entry)
              return
            }
            yield* disposeEntry(directory, entry, exit.value, action)
          }),
        { discard: true },
      )
    })

    const disposeAll = () => disposeAllOnce

    const disposeAllPromise = () => Effect.runPromise(disposeAll())
    yield* Effect.sync(() => {
      disposeLoadedInstances.add(disposeAllPromise)
    })
    yield* Effect.addFinalizer(() =>
      disposeAll().pipe(
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
