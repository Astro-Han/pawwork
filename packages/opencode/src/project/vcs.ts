import { Effect, Layer, Context, Stream, Scope } from "effect"
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
  // git's well-known empty-tree object; used as a HEAD substitute in pre-first-commit repos.
  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

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

  // True when the index column of a porcelain status code reports a staged
  // delta. Picks up "MM", "A ", "AD", etc. while excluding untracked entries
  // ("??") and worktree-only changes (" M"). Used to detect files whose
  // staged contents disagree with the ref even when the worktree happens to
  // match it — `git diff <ref>` alone misses these.
  const stagedAgainstRef = (item: Git.Item) => item.code !== "??" && item.code[0] !== " " && item.code[0] !== "?"

  const track = Effect.fnUntraced(function* (git: Git.Interface, cwd: string, ref: string | undefined) {
    const [tracked, status, headStats, cachedStats] = ref
      ? yield* Effect.all(
          [
            git.diff(cwd, ref),
            git.status(cwd),
            git.stats(cwd, ref),
            git.stats(cwd, ref, { cached: true }),
          ],
          { concurrency: 4 },
        )
      : [[] as Git.Item[], yield* git.status(cwd), [] as Git.Stat[], [] as Git.Stat[]]
    const list = ref
      ? merge(
          tracked,
          // Surface staged-only deltas the worktree-vs-ref diff would silently drop
          // (e.g. edit → git add → restore worktree to ref, leaving status "MM" but
          // `git diff <ref>` empty). merge() keeps the first occurrence per file, so
          // tracked entries win when both lists overlap.
          status.filter(stagedAgainstRef),
          status.filter((item) => item.code === "??"),
        )
      : status
    // Head stats describe worktree-vs-ref and are authoritative when present;
    // cached stats backfill staged-only files that head missed. Map iteration order
    // means later sets win, so seed with cached first then overlay head.
    const statMap = nums([...cachedStats, ...headStats])
    const batch: PatchBatch = { total: 0, capped: false }
    return yield* Effect.forEach(
      list.toSorted((a, b) => a.file.localeCompare(b.file)),
      (item) =>
        Effect.gen(function* () {
          const stat =
            statMap.get(item.file) ?? (item.status === "added" ? yield* git.statUntracked(cwd, item.file) : undefined)
          const patchOpts = { context: PATCH_CONTEXT_LINES, maxOutputBytes: MAX_PATCH_BYTES }
          const patch =
            item.code === "??" || !ref
              ? git.patchUntracked(cwd, item.file, patchOpts)
              : Effect.gen(function* () {
                  const head = yield* git.patch(cwd, ref, item.file, patchOpts)
                  if (head.truncated || head.text || !stagedAgainstRef(item)) return head
                  return yield* git.patch(cwd, ref, item.file, { ...patchOpts, cached: true })
                })
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
  })

  export const Mode = z.enum(["git", "branch"])
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
      const scope = yield* Scope.Scope

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
          yield* InstanceState.get(state).pipe(Effect.forkIn(scope))
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
          const worktree = Instance.worktree ?? Instance.directory
          if (mode === "git") {
            const ref = (yield* git.hasHead(worktree)) ? "HEAD" : undefined
            return yield* track(git, worktree, ref)
          }

          if (!value.root) return []
          if (value.current && value.current === value.root.name) return []
          const ref = yield* git.mergeBase(worktree, value.root.ref)
          if (!ref) return []
          return yield* track(git, worktree, ref)
        }),
        diffRaw: Effect.fn("Vcs.diffRaw")(function* () {
          if (Instance.project.vcs !== "git") return ""
          const worktree = Instance.worktree ?? Instance.directory
          const [hasHead, status] = yield* Effect.all([git.hasHead(worktree), git.status(worktree)], {
            concurrency: 2,
          })
          const batch: PatchBatch = { total: 0, capped: false }
          const opts = { binary: true, maxOutputBytes: MAX_TOTAL_PATCH_BYTES }
          // No-HEAD repos: a single unified patch can't carry both staged content
          // and a subsequent worktree mutation for the same path (e.g. status "AD":
          // stage-add then rm). Stitch index-vs-empty + worktree-vs-index + untracked
          // so callers see every uncommitted change; duplicate per-file headers are
          // intentional. This makes diffRaw review-oriented text, NOT guaranteed
          // git-apply-clean for mixed index/worktree states in fresh repos.
          const tracked = hasHead
            ? yield* rawPatch(batch, git.patchAll(worktree, "HEAD", opts))
            : yield* rawPatch(batch, git.patchAll(worktree, EMPTY_TREE, { ...opts, cached: true }))
          const unstaged = hasHead
            ? ""
            : yield* rawPatch(batch, git.patchAllUnstaged(worktree, opts))
          const extras = yield* Effect.forEach(
            status.filter((item) => item.code === "??"),
            (item) => rawPatch(batch, git.patchUntracked(worktree, item.file, opts)),
            { concurrency: 1 },
          )
          const patch = [tracked, unstaged, ...extras].filter(Boolean).join("\n")
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
