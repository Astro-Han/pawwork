import { GlobalBus } from "@/bus/global"
import { disposeInstance } from "@/effect/instance-registry"
import { Filesystem } from "@/util/filesystem"
import { iife } from "@/util/iife"
import { Log } from "@opencode-ai/core/util/log"
import { LocalContext } from "../util/local-context"
import { Project } from "./project"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { State } from "./state"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

const context = LocalContext.create<InstanceContext>("instance")
const cache = new Map<string, Promise<InstanceContext>>()

const disposal = {
  all: undefined as Promise<void> | undefined,
}

function emitDisposed(directory: string) {}

function boot(input: { directory: string; init?: () => Promise<any>; worktree?: string; project?: Project.Info }) {
  return iife(async () => {
    const ctx =
      input.project && input.worktree
        ? {
            directory: input.directory,
            worktree: input.worktree,
            project: input.project,
          }
        : await Project.fromDirectory(input.directory).then(({ project, sandbox }) => ({
            directory: input.directory,
            worktree: sandbox,
            project,
          }))
    await context.provide(ctx, async () => {
      await input.init?.()
    })
    return ctx
  })
}

function track(directory: string, next: Promise<InstanceContext>) {
  const task = next.catch((error) => {
    if (cache.get(directory) === task) cache.delete(directory)
    throw error
  })
  cache.set(directory, task)
  return task
}

function matchesOverride(ctx: InstanceContext, input: { worktree?: string; project?: Project.Info }) {
  if (!input.worktree && !input.project) return true
  return ctx.worktree === input.worktree && ctx.project.id === input.project?.id
}

export const Instance = {
  async provide<R>(input: {
    directory: string
    init?: () => Promise<any>
    worktree?: string
    project?: Project.Info
    fn: () => R
  }): Promise<R> {
    if (!!input.worktree !== !!input.project) {
      throw new Error("Instance.provide requires both worktree and project when overriding context")
    }

    const directory = Filesystem.resolve(input.directory)
    let existing = cache.get(directory)
    if (!existing) {
      Log.Default.info("creating instance", { directory })
      existing = track(
        directory,
        boot({
          directory,
          init: input.init,
          worktree: input.worktree,
          project: input.project,
        }),
      )
    }
    let ctx = await existing
    if (!matchesOverride(ctx, input)) {
      Log.Default.info("recreating instance with explicit context", { directory })
      existing = track(
        directory,
        boot({
          directory,
          init: input.init,
          worktree: input.worktree,
          project: input.project,
        }),
      )
      ctx = await existing
    }
    return context.provide(ctx, async () => {
      return input.fn()
    })
  },
  /**
   * Scope a function under a session's executionContext: directory = activeDirectory,
   * worktree = ownerDirectory. Reuses the per-directory instance cache so entering the
   * same worktree twice reuses the cached entry.
   *
   * The plan's naming-bridge invariant (Instance.worktree === executionContext.ownerDirectory)
   * requires both `directory` AND `worktree` to be passed to provide; otherwise Project.fromDirectory
   * would resolve a fresh worktree from the .worktrees/pawwork/<slug> path, breaking permission
   * scope and any code comparing Instance.worktree to the project root.
   */
  async activate<R>(input: {
    activeDirectory: string
    ownerDirectory: string
    project: Project.Info
    fn: () => R
  }): Promise<R> {
    return Instance.provide({
      directory: input.activeDirectory,
      worktree: Filesystem.resolve(input.ownerDirectory),
      project: input.project,
      fn: input.fn,
    })
  },
  get current() {
    return context.use()
  },
  directories() {
    return [...cache.keys()]
  },
  get directory() {
    return context.use().directory
  },
  get worktree() {
    return context.use().worktree
  },
  get project() {
    return context.use().project
  },

  /**
   * Check if a path is within the project boundary.
   * Returns true if path is inside Instance.directory OR Instance.worktree.
   * Paths within the worktree but outside the working directory should not trigger external_directory permission.
   */
  containsPath(filepath: string, ctx?: InstanceContext) {
    const instance = ctx ?? Instance
    if (Filesystem.contains(instance.directory, filepath)) return true
    // Non-git projects set worktree to "/" which would match ANY absolute path.
    // Skip worktree check in this case to preserve external_directory permissions.
    if (instance.worktree === "/") return false
    return Filesystem.contains(instance.worktree, filepath)
  },
  /**
   * Captures the current instance ALS context and returns a wrapper that
   * restores it when called. Use this for callbacks that fire outside the
   * instance async context (native addons, event emitters, timers, etc.).
   */
  bind<F extends (...args: any[]) => any>(fn: F): F {
    const ctx = context.use()
    return ((...args: any[]) => context.provide(ctx, () => fn(...args))) as F
  },
  /**
   * Run a synchronous function within the given instance context ALS.
   * Use this to bridge from Effect (where InstanceRef carries context)
   * back to sync code that reads Instance.directory from ALS.
   */
  restore<R>(ctx: InstanceContext, fn: () => R): R {
    return context.provide(ctx, fn)
  },
  state<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>): () => S {
    return State.create(() => Instance.directory, init, dispose)
  },
  async reload(input: { directory: string; init?: () => Promise<any>; project?: Project.Info; worktree?: string }) {
    const directory = Filesystem.resolve(input.directory)
    Log.Default.info("reloading instance", { directory })
    await Promise.all([State.dispose(directory), disposeInstance(directory)])
    cache.delete(directory)
    const next = track(directory, boot({ ...input, directory }))

    GlobalBus.emit("event", {
      directory,
      project: input.project?.id,
      workspace: WorkspaceContext.workspaceID,
      payload: {
        type: "server.instance.disposed",
        properties: {
          directory,
        },
      },
    })

    return await next
  },
  async dispose() {
    const directory = Instance.directory
    const project = Instance.project
    Log.Default.info("disposing instance", { directory })
    await Promise.all([State.dispose(directory), disposeInstance(directory)])
    cache.delete(directory)

    GlobalBus.emit("event", {
      directory,
      project: project.id,
      workspace: WorkspaceContext.workspaceID,
      payload: {
        type: "server.instance.disposed",
        properties: {
          directory,
        },
      },
    })
  },
  async disposeAll() {
    if (disposal.all) return disposal.all

    disposal.all = iife(async () => {
      Log.Default.info("disposing all instances")
      const entries = [...cache.entries()]
      for (const [key, value] of entries) {
        if (cache.get(key) !== value) continue

        const ctx = await value.catch((error) => {
          Log.Default.warn("instance dispose failed", { key, error })
          return undefined
        })

        if (!ctx) {
          if (cache.get(key) === value) cache.delete(key)
          continue
        }

        if (cache.get(key) !== value) continue

        await context.provide(ctx, async () => {
          await Instance.dispose()
        })
      }
    }).finally(() => {
      disposal.all = undefined
    })

    return disposal.all
  },
}
