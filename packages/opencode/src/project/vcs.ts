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
  export const MAX_APPLY_PATCH_BYTES = MAX_TOTAL_PATCH_BYTES

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

  const rawPatch = Effect.fnUntraced(function* (batch: PatchBatch, patch: Effect.Effect<Git.Patch>) {
    const result = yield* patch
    if (result.truncated) {
      return yield* Effect.fail(new RawDiffError("Raw VCS diff exceeds the 10 MB output limit", "too-large"))
    }
    const size = Buffer.byteLength(result.text)
    if (batch.total + size > MAX_TOTAL_PATCH_BYTES) {
      return yield* Effect.fail(new RawDiffError("Raw VCS diff exceeds the 10 MB output limit", "too-large"))
    }
    batch.total += size
    return result.text
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

  export const FileStatus = z
    .object({
      file: z.string(),
      additions: z.number(),
      deletions: z.number(),
      status: z.enum(["added", "deleted", "modified"]),
    })
    .meta({
      ref: "VcsFileStatus",
    })
  export type FileStatus = z.infer<typeof FileStatus>

  export const ApplyInput = z.object({
    patch: z.string(),
  })
  export type ApplyInput = z.infer<typeof ApplyInput>

  export const ApplyResult = z.object({
    applied: z.boolean(),
  })
  export type ApplyResult = z.infer<typeof ApplyResult>

  export const ApplyError = z
    .object({
      error: z.literal("vcs_apply_failed"),
      reason: z.enum(["non-git", "not-clean", "too-large", "invalid-input"]),
      message: z.string(),
    })
    .meta({
      ref: "VcsApplyFailure",
    })
  export type ApplyError = z.infer<typeof ApplyError>

  export const DiffRawError = z
    .object({
      error: z.literal("vcs_diff_raw_failed"),
      reason: z.literal("too-large"),
      message: z.string(),
    })
    .meta({
      ref: "VcsDiffRawFailure",
    })
  export type DiffRawError = z.infer<typeof DiffRawError>

  export class RawDiffError extends Error {
    constructor(
      message: string,
      readonly reason: DiffRawError["reason"],
    ) {
      super(message)
      this.name = "VcsRawDiffError"
    }
  }

  export class PatchApplyError extends Error {
    constructor(
      message: string,
      readonly reason: ApplyError["reason"],
    ) {
      super(message)
      this.name = "VcsPatchApplyError"
    }
  }

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    readonly branch: () => Effect.Effect<string | undefined>
    readonly defaultBranch: () => Effect.Effect<string | undefined>
    readonly status: () => Effect.Effect<FileStatus[]>
    readonly diff: (mode: Mode) => Effect.Effect<FileDiff[]>
    readonly diffRaw: () => Effect.Effect<string, RawDiffError>
    readonly apply: (input: ApplyInput) => Effect.Effect<ApplyResult, PatchApplyError>
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
        status: Effect.fn("Vcs.status")(function* () {
          if (Instance.project.vcs !== "git") return []
          const worktree = Instance.worktree ?? Instance.directory
          const ref = (yield* git.hasHead(worktree)) ? "HEAD" : undefined
          const [list, stats] = yield* Effect.all(
            [git.status(worktree), ref ? git.stats(worktree, ref) : Effect.succeed([])],
            { concurrency: 2 },
          )
          const statMap = nums(stats)
          return yield* Effect.forEach(
            list.toSorted((a, b) => a.file.localeCompare(b.file)),
            (item) =>
              Effect.gen(function* () {
                const stat =
                  statMap.get(item.file) ??
                  (item.status === "added" ? yield* git.statUntracked(worktree, item.file) : undefined)
                return {
                  file: item.file,
                  additions: stat?.additions ?? 0,
                  deletions: stat?.deletions ?? 0,
                  status: item.status,
                } satisfies FileStatus
              }),
          )
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
        diffRaw: Effect.fn("Vcs.diffRaw")(function* () {
          if (Instance.project.vcs !== "git") return ""
          const worktree = Instance.worktree ?? Instance.directory
          const [hasHead, status] = yield* Effect.all([git.hasHead(worktree), git.status(worktree)], {
            concurrency: 2,
          })
          const batch: PatchBatch = { total: 0, capped: false }
          const tracked = yield* rawPatch(
            batch,
            hasHead
              ? git.patchAll(worktree, "HEAD", { binary: true, maxOutputBytes: MAX_TOTAL_PATCH_BYTES })
              : git.patchStagedAll(worktree, { binary: true, maxOutputBytes: MAX_TOTAL_PATCH_BYTES }),
          )
          const untracked = yield* Effect.forEach(
            status.filter((item) => item.code === "??"),
            (item) =>
              rawPatch(
                batch,
                git.patchUntracked(worktree, item.file, { binary: true, maxOutputBytes: MAX_TOTAL_PATCH_BYTES }),
              ),
            { concurrency: 1 },
          )
          const initialWorktree = hasHead
            ? []
            : yield* Effect.forEach(
                status.filter((item) => item.code !== "??" && item.code[1] !== " "),
                (item) =>
                  rawPatch(
                    batch,
                    git.patchUnstaged(worktree, item.file, { binary: true, maxOutputBytes: MAX_TOTAL_PATCH_BYTES }),
                  ),
                { concurrency: 1 },
              )
          const patch = [tracked, ...initialWorktree, ...untracked].filter(Boolean).join("\n")
          if (Buffer.byteLength(patch) > MAX_TOTAL_PATCH_BYTES) {
            return yield* Effect.fail(new RawDiffError("Raw VCS diff exceeds the 10 MB output limit", "too-large"))
          }
          return patch
        }),
        apply: Effect.fn("Vcs.apply")(function* (input: ApplyInput) {
          if (Buffer.byteLength(input.patch) > MAX_APPLY_PATCH_BYTES) {
            return yield* Effect.fail(new PatchApplyError("Patch exceeds the 10 MB input limit", "too-large"))
          }
          if (Instance.project.vcs !== "git") {
            return yield* Effect.fail(new PatchApplyError("Patch can't be applied because the project is not git-based", "non-git"))
          }
          const applied = yield* git.applyPatch(Instance.worktree ?? Instance.directory, input.patch)
          if (applied.exitCode !== 0) {
            return yield* Effect.fail(new PatchApplyError("Patch can't be applied", "not-clean"))
          }
          return { applied: true }
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

  export async function status() {
    return runPromise((svc) => svc.status())
  }

  export async function diff(mode: Mode) {
    return runPromise((svc) => svc.diff(mode))
  }

  export async function diffRaw() {
    return runPromise((svc) => svc.diffRaw())
  }

  export async function apply(input: ApplyInput) {
    return runPromise((svc) => svc.apply(input))
  }
}
