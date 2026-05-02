import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./exit-worktree.txt"
import * as Session from "../session/session"
import { hasInFlightToolCallsExcept, hasRunningSubagents } from "../session/state-machine-guard"
import { SubagentRun } from "../session/subagent-run"
import { sameDirectory } from "../session/execution-context"

export const Parameters = Schema.Struct({})

export const ExitWorktreeTool = Tool.define(
  "exit-worktree",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const subagents = yield* SubagentRun.Service

    const run = (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        if (ctx.callID) {
          const inFlight = yield* hasInFlightToolCallsExcept(sessions, ctx.sessionID, ctx.callID)
          if (inFlight) {
            return yield* Effect.fail(
              new Error("Cannot exit a worktree while another tool call is running in this session."),
            )
          }
        }
        const subs = yield* hasRunningSubagents(subagents, ctx.sessionID)
        if (subs) {
          return yield* Effect.fail(
            new Error("Cannot exit a worktree while a subagent is running in this session."),
          )
        }

        const session = yield* sessions.get(ctx.sessionID)
        const exec = session.executionContext
        type ExitMetadata = {
          activeDirectory: string
          previousSlug?: string
          previousBranch?: string
          previousDirectory?: string
          previousSource?: "created" | "existing"
        }
        if (sameDirectory(exec.activeDirectory, exec.ownerDirectory) && exec.activeWorktree === undefined) {
          const metadata: ExitMetadata = { activeDirectory: exec.ownerDirectory }
          return {
            title: "Already at project root",
            output: `Returned to project root ${exec.ownerDirectory}. Subsequent paths resolve from this directory.`,
            metadata,
          }
        }

        const previous = exec.activeWorktree
        yield* sessions.updateExecutionContext({
          sessionID: ctx.sessionID,
          activeDirectory: exec.ownerDirectory,
          activeWorktree: null,
        })
        const metadata: ExitMetadata = {
          activeDirectory: exec.ownerDirectory,
          previousSlug: previous?.name,
          previousBranch: previous?.branch,
          previousDirectory: previous?.directory,
          previousSource: previous?.source,
        }
        return {
          title: "Exited worktree",
          output: `Returned to project root ${exec.ownerDirectory}. Subsequent paths resolve from this directory.`,
          metadata,
        }
      })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
