import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./exit-worktree.txt"
import * as Session from "../session/session"
import { hasInFlightToolCallsExcept, hasRunningSubagents } from "../session/state-machine-guard"

export const Parameters = Schema.Struct({})

export const ExitWorktreeTool = Tool.define(
  "exit-worktree",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

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
        const subs = yield* hasRunningSubagents(ctx.sessionID)
        if (subs) {
          return yield* Effect.fail(
            new Error("Cannot exit a worktree while a subagent is running in this session."),
          )
        }

        const session = yield* sessions.get(ctx.sessionID)
        const exec = session.executionContext
        if (exec.activeDirectory === exec.ownerDirectory && exec.activeWorktree === undefined) {
          return {
            title: "Already at project root",
            output: `Returned to project root ${exec.ownerDirectory}. Subsequent paths resolve from this directory.`,
            metadata: { activeDirectory: exec.ownerDirectory },
          }
        }

        yield* sessions.updateExecutionContext({
          sessionID: ctx.sessionID,
          activeDirectory: exec.ownerDirectory,
          activeWorktree: null,
        })
        return {
          title: "Exited worktree",
          output: `Returned to project root ${exec.ownerDirectory}. Subsequent paths resolve from this directory.`,
          metadata: { activeDirectory: exec.ownerDirectory },
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
