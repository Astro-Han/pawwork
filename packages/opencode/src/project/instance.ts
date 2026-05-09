import { Filesystem } from "@/util/filesystem"
import { context, containsPath as containsPathInContext, type InstanceContext } from "./instance-context"
import { Project } from "./project"
import { State } from "./state"

export type { InstanceContext } from "./instance-context"

const directories = new Set<string>()

async function runtime() {
  return (await import("./instance-runtime")).InstanceRuntime
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
    const instanceRuntime = await runtime()
    const ctx = await instanceRuntime.load({
      directory,
      worktree: input.worktree,
      project: input.project,
    })
    directories.add(ctx.directory)
    return context.provide(ctx, async () => {
      await input.init?.()
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
    return [...directories]
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
  containsPath(filepath: string, ctx?: InstanceContext) {
    return containsPathInContext(filepath, ctx ?? context.use())
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
    if (!!input.worktree !== !!input.project) {
      throw new Error("Instance.reload requires both worktree and project when overriding context")
    }
    const directory = Filesystem.resolve(input.directory)
    const instanceRuntime = await runtime()
    const ctx = await instanceRuntime.reloadInstance({
      directory,
      worktree: input.worktree,
      project: input.project,
    })
    directories.add(ctx.directory)
    await context.provide(ctx, () => input.init?.())
    return ctx
  },
  async dispose() {
    const ctx = Instance.current
    const instanceRuntime = await runtime()
    await instanceRuntime.disposeInstance(ctx)
    directories.delete(ctx.directory)
  },
  async disposeAll() {
    const { disposeAllLoadedInstances } = await import("./instance-store")
    await disposeAllLoadedInstances()
    directories.clear()
  },
}
