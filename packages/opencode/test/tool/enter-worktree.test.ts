import { expect, test } from "bun:test"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { SubagentRun } from "../../src/session/subagent-run"
import { EnterWorktreeTool } from "../../src/tool/enter-worktree"
import { ExitWorktreeTool } from "../../src/tool/exit-worktree"
import type { Context } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { Worktree } from "../../src/worktree"
import { tmpdir } from "../fixture/fixture"

const layer = Layer.mergeAll(
  Agent.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Session.defaultLayer,
  SubagentRun.defaultLayer,
  Truncate.defaultLayer,
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

function run<R>(effect: Effect.Effect<R, unknown, any>) {
  return Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<R, unknown, never>)
}

test("enter-worktree rejects relative path inputs", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const exit = await run(
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "relative-path" })
          const tool = yield* EnterWorktreeTool
          const def = yield* tool.init()
          return yield* def.execute({ path: "relative-worktree" }, toolContext(session.id)).pipe(Effect.exit)
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("path must be an absolute path")
    },
  })
})

test("enter-worktree and exit-worktree update the session execution context", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let activeDirectory = ""
      try {
        await run(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const session = yield* sessions.create({ title: "tool-worktree" })
            const enterTool = yield* EnterWorktreeTool
            const exitTool = yield* ExitWorktreeTool
            const enter = yield* enterTool.init()
            const exit = yield* exitTool.init()

            const result = yield* enter.execute({ name: "tool-work" }, toolContext(session.id))
            activeDirectory = result.metadata.activeDirectory
            expect(result.metadata.ownerDirectory).toBe(tmp.path)
            expect(result.metadata.branch).toBe("pawwork/tool-work")
            expect(result.metadata.slug).toBe("tool-work")

            const entered = yield* sessions.get(session.id)
            expect(entered.executionContext.activeDirectory).toBe(activeDirectory)
            expect(entered.executionContext.activeWorktree?.name).toBe("tool-work")

            const exitResult = yield* exit.execute({}, toolContext(session.id))
            expect(exitResult.metadata.activeDirectory).toBe(tmp.path)
            expect(exitResult.metadata.previousSlug).toBe("tool-work")
            expect(exitResult.metadata.previousBranch).toBe("pawwork/tool-work")
            expect(exitResult.metadata.previousDirectory).toBe(activeDirectory)

            const exited = yield* sessions.get(session.id)
            expect(exited.executionContext.activeDirectory).toBe(tmp.path)
            expect(exited.executionContext.activeWorktree).toBeUndefined()
          }),
        )
      } finally {
        if (activeDirectory) await Worktree.remove({ directory: activeDirectory }).catch(() => {})
      }
    },
  })
})
