import { expect } from "bun:test"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Session } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { SubagentRun } from "../../src/session/subagent-run"
import { EnterWorktreeTool } from "../../src/tool/enter-worktree"
import { ExitWorktreeTool } from "../../src/tool/exit-worktree"
import type { Context } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SubagentRun.defaultLayer,
    Truncate.defaultLayer,
  ),
)

function toolContext(sessionID: Session.Info["id"]): Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    callID: "call_test",
    extra: {},
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

it.live("enter-worktree rejects relative path inputs", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "relative-path" })
        const tool = yield* EnterWorktreeTool
        const def = yield* tool.init()
        return yield* def.execute({ path: "relative-worktree" }, toolContext(session.id)).pipe(Effect.exit)
      }).pipe(
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("path must be an absolute path")
          }),
        ),
      ),
    { git: true },
  ),
)

it.live("enter-worktree and exit-worktree update the session execution context", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "tool-worktree" })
        const enterTool = yield* EnterWorktreeTool
        const exitTool = yield* ExitWorktreeTool
        const enter = yield* enterTool.init()
        const exit = yield* exitTool.init()

        const result = yield* enter.execute({ name: "tool-work" }, toolContext(session.id))
        const activeDirectory = result.metadata.activeDirectory
        expect(result.metadata.ownerDirectory).toBe(dir)
        expect(result.metadata.branch).toBe("pawwork/tool-work")
        expect(result.metadata.slug).toBe("tool-work")

        const entered = yield* sessions.get(session.id)
        expect(entered.executionContext.activeDirectory).toBe(activeDirectory)
        expect(entered.executionContext.activeWorktree?.name).toBe("tool-work")

        const exitResult = yield* exit.execute({}, toolContext(session.id))
        expect(exitResult.metadata.activeDirectory).toBe(dir)
        expect(exitResult.metadata.previousSlug).toBe("tool-work")
        expect(exitResult.metadata.previousBranch).toBe("pawwork/tool-work")
        expect(exitResult.metadata.previousDirectory).toBe(activeDirectory)
        expect(exitResult.metadata.previousSource).toBe("created")

        const exited = yield* sessions.get(session.id)
        expect(exited.executionContext.activeDirectory).toBe(dir)
        expect(exited.executionContext.activeWorktree).toBeUndefined()

        yield* sessions.updateExecutionContext({
          sessionID: session.id,
          activeDirectory: `${dir}/`,
        })
        const alreadyRoot = yield* exit.execute({}, toolContext(session.id))
        expect(alreadyRoot.title).toBe("Already at project root")

        yield* enter.execute({ path: activeDirectory }, toolContext(session.id))
        const pathExit = yield* exit.execute({}, toolContext(session.id))
        expect(pathExit.metadata.previousSource).toBe("created")
      }),
    { git: true },
  ),
)
