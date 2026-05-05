import { expect } from "bun:test"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { SubagentRun } from "../../src/session/subagent-run"
import { EnterWorktreeTool } from "../../src/tool/enter-worktree"
import { ExitWorktreeTool } from "../../src/tool/exit-worktree"
import type { Context } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { ModelID, ProviderID } from "../../src/provider/schema"
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

function toolContext(
  sessionID: Session.Info["id"],
  input?: { messageID?: MessageID; callID?: string },
): Context {
  return {
    sessionID,
    messageID: input?.messageID ?? MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    callID: input?.callID ?? "call_test",
    extra: {},
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const model = {
  providerID: ProviderID.openai,
  modelID: ModelID.make("test-model"),
}

const tokens = {
  total: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

function addAssistantToolPart(input: {
  sessions: Session.Service["Service"]
  sessionID: Session.Info["id"]
  messageID: MessageID
  root: string
  callID: string
  status: "pending" | "running"
}) {
  return Effect.gen(function* () {
    const message: MessageV2.Assistant = {
      id: input.messageID,
      role: "assistant",
      sessionID: input.sessionID,
      parentID: MessageID.ascending(),
      modelID: model.modelID,
      providerID: model.providerID,
      mode: "build",
      agent: "build",
      path: { cwd: input.root, root: input.root },
      cost: 0,
      tokens,
      time: { created: Date.now(), completed: Date.now() },
      finish: "tool-calls",
    }
    yield* input.sessions.updateMessage(message)
    yield* input.sessions.updatePart({
      id: PartID.ascending(),
      messageID: input.messageID,
      sessionID: input.sessionID,
      type: "tool",
      tool: "bash",
      callID: input.callID,
      state:
        input.status === "running"
          ? { status: "running", input: { cmd: "pwd" }, time: { start: Date.now() } }
          : { status: "pending", input: { cmd: "pwd" }, raw: "" },
    })
  })
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

it.live("exit-worktree ignores stale historical running tool parts", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "stale-historical-tool" })
        const enterTool = yield* EnterWorktreeTool
        const exitTool = yield* ExitWorktreeTool
        const enter = yield* enterTool.init()
        const exit = yield* exitTool.init()

        const entered = yield* enter.execute({ name: "stale-tool" }, toolContext(session.id))
        yield* addAssistantToolPart({
          sessions,
          sessionID: session.id,
          messageID: MessageID.ascending(),
          root: dir,
          callID: "call_historical_running",
          status: "running",
        })

        const result = yield* exit.execute({}, toolContext(session.id, { messageID: MessageID.ascending() }))

        expect(result.title).toBe("Exited worktree")
        expect(result.metadata.activeDirectory).toBe(dir)
        expect(result.metadata.previousDirectory).toBe(entered.metadata.activeDirectory)
      }),
    { git: true },
  ),
)

it.live("exit-worktree rejects unresolved tool parts in the current assistant message", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "current-tool-running" })
        const enterTool = yield* EnterWorktreeTool
        const exitTool = yield* ExitWorktreeTool
        const enter = yield* enterTool.init()
        const exit = yield* exitTool.init()

        yield* enter.execute({ name: "current-tool" }, toolContext(session.id))
        const currentMessageID = MessageID.ascending()
        yield* addAssistantToolPart({
          sessions,
          sessionID: session.id,
          messageID: currentMessageID,
          root: dir,
          callID: "call_other_running",
          status: "running",
        })

        const result = yield* exit
          .execute({}, toolContext(session.id, { messageID: currentMessageID, callID: "call_exit" }))
          .pipe(Effect.exit)

        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          expect(Cause.pretty(result.cause)).toContain(
            "Cannot exit a worktree while another tool call is running in this session.",
          )
        }
      }),
    { git: true },
  ),
)
