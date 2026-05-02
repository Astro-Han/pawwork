import { Effect, Schema } from "effect"
import * as path from "path"
import { promises as fs } from "fs"
import * as Tool from "./tool"
import DESCRIPTION from "./enter-worktree.txt"
import * as Session from "../session/session"
import { Worktree } from "../worktree"
import { Instance } from "../project/instance"
import { hasInFlightToolCallsExcept, hasRunningSubagents } from "../session/state-machine-guard"
import type { SessionID } from "../session/schema"
import { SubagentRun } from "../session/subagent-run"
import { currentBranch, gitCommonDir } from "./enter-worktree-git"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { canonicalDirectory, sameDirectory } from "../session/execution-context"

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_SLUG_LEN = 40

export const Parameters = Schema.Struct({
  name: Schema.optional(Schema.String).annotate({
    description:
      "Slug for a managed worktree (kebab-case, [a-z0-9-]+, max 40). If omitted, a slug is auto-generated. Mutually exclusive with `path`.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "Absolute path to an existing same-repo worktree to take over. Mutually exclusive with `name`.",
  }),
})

export const EnterWorktreeTool = Tool.define(
  "enter-worktree",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const subagents = yield* SubagentRun.Service
    const spawner = yield* ChildProcessSpawner

    const guard = (sessionID: SessionID, callID: string | undefined) =>
      Effect.gen(function* () {
        if (callID) {
          const inFlight = yield* hasInFlightToolCallsExcept(sessions, sessionID, callID)
          if (inFlight) {
            return yield* Effect.fail(
              new Error("Cannot enter a worktree while another tool call is running in this session."),
            )
          }
        }
        const subs = yield* hasRunningSubagents(subagents, sessionID)
        if (subs) {
          return yield* Effect.fail(new Error("Cannot enter a worktree while a subagent is running in this session."))
        }
      })

    const applyEnter = (sessionID: SessionID, info: Worktree.Info, source: "created" | "existing") =>
      sessions.updateExecutionContext({
        sessionID,
        activeDirectory: info.directory,
        activeWorktree: {
          directory: info.directory,
          name: info.name,
          branch: info.branch,
          source,
        },
      })

    const successResult = (input: {
      activeDirectory: string
      ownerDirectory: string
      slug: string
      branch: string
      state: "created" | "reused"
    }): Tool.ExecuteResult => ({
      title: `Entered worktree ${input.slug}`,
      output: `Now active in ${input.activeDirectory} (branch ${input.branch}, slug ${input.slug}). Subsequent paths resolve from this directory.`,
      metadata: {
        activeDirectory: input.activeDirectory,
        ownerDirectory: input.ownerDirectory,
        slug: input.slug,
        branch: input.branch,
        state: input.state,
      },
    })

    const run = (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        if (params.name && params.path) {
          return yield* Effect.fail(new Error("name and path are mutually exclusive"))
        }
        if (params.name && !SLUG_RE.test(params.name)) {
          return yield* Effect.fail(
            new Error("name must be kebab-case, [a-z0-9-]+, no leading/trailing or double hyphens"),
          )
        }
        if (params.name && params.name.length > MAX_SLUG_LEN) {
          return yield* Effect.fail(new Error(`name max ${MAX_SLUG_LEN} chars`))
        }

        yield* guard(ctx.sessionID, ctx.callID)

        const project = Instance.project
        if (project.vcs !== "git") {
          return yield* Effect.fail(new Error("This project is not a git repository."))
        }

        const session = yield* sessions.get(ctx.sessionID)
        const exec = session.executionContext

        if (params.path) {
          if (!path.isAbsolute(params.path)) {
            return yield* Effect.fail(new Error("path must be an absolute path"))
          }
          const canonical = yield* Effect.promise(() =>
            fs.realpath(params.path!).catch(() => path.resolve(params.path!)),
          )
          if (sameDirectory(exec.activeDirectory, canonical)) {
            const slug = exec.activeWorktree?.name ?? path.basename(canonical)
            return successResult({
              activeDirectory: canonical,
              ownerDirectory: exec.ownerDirectory,
              slug,
              branch: exec.activeWorktree?.branch ?? "",
              state: "reused",
            })
          }
          if (!sameDirectory(exec.activeDirectory, exec.ownerDirectory)) {
            return yield* Effect.fail(
              new Error("This session is already inside another worktree. Call ExitWorktree first."),
            )
          }
          const ownerCommon = yield* gitCommonDir(spawner, exec.ownerDirectory)
          const targetCommon = yield* gitCommonDir(spawner, canonical)
          if (!ownerCommon || !targetCommon || !sameDirectory(ownerCommon, targetCommon)) {
            return yield* Effect.fail(
              new Error(`Path ${canonical} is not part of the same git repository as the project.`),
            )
          }
          const branch = yield* currentBranch(spawner, canonical)
          const info = yield* Effect.promise(() => Worktree.registerExistingByPath(canonical))
          yield* applyEnter(ctx.sessionID, { ...info, branch: info.branch || branch }, info.source)
          return successResult({
            activeDirectory: canonical,
            ownerDirectory: exec.ownerDirectory,
            slug: info.name,
            branch: info.branch || branch,
            state: "reused",
          })
        }

        // name= or no-arg branch
        const existing = params.name ? yield* Effect.promise(() => Worktree.lookupBySlug(params.name!)) : undefined
        const planned = existing ?? (yield* Effect.promise(() => Worktree.makeWorktreeInfo(params.name)))
        if (sameDirectory(exec.activeDirectory, planned.directory)) {
          return successResult({
            activeDirectory: planned.directory,
            ownerDirectory: exec.ownerDirectory,
            slug: planned.name,
            branch: planned.branch,
            state: "reused",
          })
        }
        if (!sameDirectory(exec.activeDirectory, exec.ownerDirectory)) {
          return yield* Effect.fail(
            new Error("This session is already inside another worktree. Call ExitWorktree first."),
          )
        }
        const exists = yield* Effect.promise(() =>
          fs
            .stat(planned.directory)
            .then(() => true)
            .catch(() => false),
        )
        if (!exists) {
          yield* Effect.promise(() => Worktree.createFromInfo(planned))
        } else {
          const ownerCommon = yield* gitCommonDir(spawner, exec.ownerDirectory)
          const targetCommon = yield* gitCommonDir(spawner, planned.directory)
          if (!ownerCommon || !targetCommon || !sameDirectory(ownerCommon, targetCommon)) {
            return yield* Effect.fail(
              new Error(`Managed worktree directory ${planned.directory} exists but is not a git worktree.`),
            )
          }
        }
        yield* applyEnter(ctx.sessionID, planned, planned.source)
        return successResult({
          activeDirectory: planned.directory,
          ownerDirectory: exec.ownerDirectory,
          slug: planned.name,
          branch: planned.branch,
          state: exists ? "reused" : "created",
        })
      })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
