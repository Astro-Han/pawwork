import { Effect, Layer, Context, Stream } from "effect"
import { formatPatch, structuredPatch } from "diff"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { FileWatcher } from "@/file/watcher"
import { Git } from "@/git"
import { Log } from "@opencode-ai/core/util/log"
import { Instance } from "./instance"
import z from "zod"

export namespace Vcs {
  const log = Log.create({ service: "vcs" })
  const PATCH_CONTEXT_LINES = 2_147_483_647
  // A single useful patch may consume the whole budget; later files then fall back to empty patches.
  const MAX_PATCH_BYTES = 10_000_000
  const MAX_TOTAL_PATCH_BYTES = 10_000_000

  const emptyPatch = (file: string) => formatPatch(structuredPatch(file, file, "", "", "", "", { context: 0 }))

  const nums = (list: Git.Stat[]) =>
    new Map(list.map((item) => [item.file, { additions: item.additions, deletions: item.deletions }] as const))

  const merge = (...lists: Git.Item[][]) => {
    const out = new Map<string, Git.Item>()
    lists.flat().forEach((item) => {
      if (!out.has(item.file)) out.set(item.file, item)
    })
    return [...out.values()]
  }

  type PatchBatch = { total: number; capped: boolean }

  const boundedPatch = Effect.fnUntraced(function* (
    batch: PatchBatch,
    item: Git.Item,
    patch: Effect.Effect<Git.Patch>,
  ) {
    if (batch.capped) return emptyPatch(item.file)
    const result = yield* patch
    if (result.truncated) {
      batch.capped = true
      return emptyPatch(item.file)
    }
    const size = Buffer.byteLength(result.text)
    if (batch.total + size > MAX_TOTAL_PATCH_BYTES) {
      batch.capped = true
      return emptyPatch(item.file)
    }
    batch.total += size
    return result.text || emptyPatch(item.file)
  })

  const staged = Effect.fnUntraced(function* (git: Git.Interface, cwd: string) {
    const [list, stats] = yield* Effect.all([git.diffStaged(cwd), git.statsStaged(cwd)], { concurrency: 2 })
    const statMap = nums(stats)
    const batch: PatchBatch = { total: 0, capped: false }
    const next = yield* Effect.forEach(
      list.toSorted((a, b) => a.file.localeCompare(b.file)),
      (item) =>
        Effect.gen(function* () {
          const stat = statMap.get(item.file)
          return {
            file: item.file,
            patch: yield* boundedPatch(batch, item, git.patchStaged(cwd, item.file, {
              context: PATCH_CONTEXT_LINES,
              maxOutputBytes: MAX_PATCH_BYTES,
            })),
            additions: stat?.additions ?? 0,
            deletions: stat?.deletions ?? 0,
            status: item.status,
          } satisfies FileDiff
        }),
      { concurrency: 1 },
    )
    return next
  })

  const unstaged = Effect.fnUntraced(function* (git: Git.Interface, cwd: string) {
    const [tracked, extra, stats] = yield* Effect.all(
      [git.diffUnstaged(cwd), git.statusUnstaged(cwd), git.statsUnstaged(cwd)],
      { concurrency: 3 },
    )
    const list = merge(
      tracked,
      extra.filter((item) => item.code === "??"),
    )
    const statMap = nums(stats)
    const batch: PatchBatch = { total: 0, capped: false }
    const next = yield* Effect.forEach(
      list.toSorted((a, b) => a.file.localeCompare(b.file)),
      (item) =>
        Effect.gen(function* () {
          const stat = statMap.get(item.file) ?? (item.status === "added" ? yield* git.statUntracked(cwd, item.file) : undefined)
          const patch =
            item.code === "??"
              ? git.patchUntracked(cwd, item.file, { context: PATCH_CONTEXT_LINES, maxOutputBytes: MAX_PATCH_BYTES })
              : git.patchUnstaged(cwd, item.file, { context: PATCH_CONTEXT_LINES, maxOutputBytes: MAX_PATCH_BYTES })
          return {
            file: item.file,
            patch: yield* boundedPatch(batch, item, patch),
            additions: stat?.additions ?? 0,
            deletions: stat?.deletions ?? 0,
            status: item.status,
          } satisfies FileDiff
        }),
      { concurrency: 1 },
    )
    return next
  })

  const branchHead = Effect.fnUntraced(function* (git: Git.Interface, cwd: string, ref: string) {
    const [list, stats] = yield* Effect.all([git.diffHead(cwd, ref), git.statsHead(cwd, ref)], { concurrency: 2 })
    const statMap = nums(stats)
    const batch: PatchBatch = { total: 0, capped: false }
    const next = yield* Effect.forEach(
      list.toSorted((a, b) => a.file.localeCompare(b.file)),
      (item) =>
        Effect.gen(function* () {
          const stat = statMap.get(item.file)
          return {
            file: item.file,
            patch: yield* boundedPatch(batch, item, git.patchHead(cwd, ref, item.file, {
              context: PATCH_CONTEXT_LINES,
              maxOutputBytes: MAX_PATCH_BYTES,
            })),
            additions: stat?.additions ?? 0,
            deletions: stat?.deletions ?? 0,
            status: item.status,
          } satisfies FileDiff
        }),
      { concurrency: 1 },
    )
    return next
  })

  export const Mode = z.enum(["unstaged", "staged", "branch"])
  export type Mode = z.infer<typeof Mode>

  export const Event = {
    BranchUpdated: BusEvent.define(
      "vcs.branch.updated",
      z.object({
        branch: z.string().optional(),
      }),
    ),
  }

  export const Info = z
    .object({
      branch: z.string().optional(),
      default_branch: z.string().optional(),
    })
    .meta({
      ref: "VcsInfo",
    })
  export type Info = z.infer<typeof Info>

  export const FileDiff = z
    .object({
      file: z.string(),
      patch: z.string(),
      additions: z.number(),
      deletions: z.number(),
      status: z.enum(["added", "deleted", "modified"]).optional(),
    })
    .meta({
      ref: "VcsFileDiff",
    })
  export type FileDiff = z.infer<typeof FileDiff>

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    readonly branch: () => Effect.Effect<string | undefined>
    readonly defaultBranch: () => Effect.Effect<string | undefined>
    readonly diff: (mode: Mode) => Effect.Effect<FileDiff[]>
  }

  interface State {
    current: string | undefined
    root: Git.Base | undefined
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Vcs") {}

  export const layer: Layer.Layer<Service, never, Git.Service | Bus.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const git = yield* Git.Service
      const bus = yield* Bus.Service

      const state = yield* InstanceState.make<State>(
        Effect.fn("Vcs.state")(function* (ctx) {
          if (ctx.project.vcs !== "git") {
            return { current: undefined, root: undefined }
          }

          const get = Effect.fnUntraced(function* () {
            return yield* git.branch(ctx.directory)
          })
          const [current, root] = yield* Effect.all([git.branch(ctx.directory), git.defaultBranch(ctx.directory)], {
            concurrency: 2,
          })
          const value = { current, root }
          log.info("initialized", { branch: value.current, default_branch: value.root?.name })

          yield* bus.subscribe(FileWatcher.Event.Updated).pipe(
            Stream.filter((evt) => evt.properties.file.endsWith("HEAD")),
            Stream.runForEach((_evt) =>
              Effect.gen(function* () {
                const next = yield* get()
                if (next !== value.current) {
                  log.info("branch changed", { from: value.current, to: next })
                  value.current = next
                  yield* bus.publish(Event.BranchUpdated, { branch: next })
                }
              }),
            ),
            Effect.forkScoped,
          )

          return value
        }),
      )

      return Service.of({
        init: Effect.fn("Vcs.init")(function* () {
          yield* InstanceState.get(state)
        }),
        branch: Effect.fn("Vcs.branch")(function* () {
          return yield* InstanceState.use(state, (x) => x.current)
        }),
        defaultBranch: Effect.fn("Vcs.defaultBranch")(function* () {
          return yield* InstanceState.use(state, (x) => x.root?.name)
        }),
        diff: Effect.fn("Vcs.diff")(function* (mode: Mode) {
          const value = yield* InstanceState.get(state)
          if (Instance.project.vcs !== "git") return []
          if (mode === "unstaged") {
            return yield* unstaged(git, Instance.directory)
          }

          if (mode === "staged") {
            return yield* staged(git, Instance.directory)
          }

          if (!value.root) return []
          if (value.current && value.current === value.root.name) return []
          const ref = yield* git.mergeBase(Instance.directory, value.root.ref)
          if (!ref) return []
          return yield* branchHead(git, Instance.directory, ref)
        }),
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Git.defaultLayer), Layer.provide(Bus.layer))

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function init() {
    return runPromise((svc) => svc.init())
  }

  export async function branch() {
    return runPromise((svc) => svc.branch())
  }

  export async function defaultBranch() {
    return runPromise((svc) => svc.defaultBranch())
  }

  export async function diff(mode: Mode) {
    return runPromise((svc) => svc.diff(mode))
  }
}
