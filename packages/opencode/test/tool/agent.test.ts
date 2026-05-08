import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { AgentTool, sanitizeErrorMessage, type AgentPromptOps } from "../../src/tool/agent"
import { SubagentRun } from "../../src/session/subagent-run"
import { Truncate } from "../../src/tool/truncate"
import { ToolRegistry } from "../../src/tool/registry"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SubagentRun.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

const seedAssistant = Effect.fn("AgentToolTest.seedAssistant")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return assistant
})

const seed = Effect.fn("AgentToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const assistant = yield* seedAssistant(chat.id)
  return { chat, assistant }
})

function stubOps(opts?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  text?: string
  interruptedSessions?: ReadonlySet<string>
}): AgentPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
    wasInterrupted: (id) => opts?.interruptedSessions?.has(id) ?? false,
  }
}

function reply(input: Parameters<typeof SessionPrompt.prompt>[0], text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("sanitizeErrorMessage", () => {
  // Invariant-style assertions: output must not contain any sensitive substring from the
  // input. This is what catches regressions when a future field shape (e.g. WSL paths,
  // Cygwin mounts) leaks through; it does not depend on the literal replacement format.
  const cases: ReadonlyArray<{ name: string; input: string; sensitive: ReadonlyArray<string> }> = [
    { name: "POSIX home (Mac)", input: "ENOENT /Users/alice/secret/data.json", sensitive: ["alice", "secret/data.json"] },
    { name: "POSIX home (Linux)", input: "open /home/alice/.ssh/id_rsa failed", sensitive: ["alice", ".ssh/id_rsa"] },
    { name: "Windows drive path", input: "Cannot find C:\\Users\\alice\\AppData\\Roaming\\app.json", sensitive: ["alice", "AppData", "app.json"] },
    { name: "Windows UNC path", input: "Mount failed at \\\\fileserver\\share\\confidential", sensitive: ["fileserver", "confidential"] },
    { name: "JSON envelope leak", input: 'request failed: {"apiKey":"sk-real-token","trace":"oops"}', sensitive: ["sk-real-token", "apiKey"] },
  ]
  for (const { name, input, sensitive } of cases) {
    test(name, () => {
      const out = sanitizeErrorMessage(input)
      for (const s of sensitive) expect(out).not.toContain(s)
    })
  }
})

describe("tool.agent", () => {
  it.live("description sorts subagents by name and is stable across calls", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agent = yield* Agent.Service
          const build = yield* agent.get("build")
          const registry = yield* ToolRegistry.Service
          const get = Effect.fnUntraced(function* () {
            const tools = yield* registry.tools({ ...ref, agent: build })
            return tools.find((tool) => tool.id === AgentTool.id)?.description ?? ""
          })
          const first = yield* get()
          const second = yield* get()

          expect(first).toBe(second)

          const alpha = first.indexOf("- alpha: Alpha agent")
          const explore = first.indexOf("- explore:")
          const general = first.indexOf("- general:")
          const zebra = first.indexOf("- zebra: Zebra agent")

          expect(alpha).toBeGreaterThan(-1)
          expect(explore).toBeGreaterThan(alpha)
          expect(general).toBeGreaterThan(explore)
          expect(zebra).toBeGreaterThan(general)
        }),
      {
        config: {
          agent: {
            zebra: {
              description: "Zebra agent",
              mode: "subagent",
            },
            alpha: {
              description: "Alpha agent",
              mode: "subagent",
            },
          },
        },
      },
    ),
  )

  it.live("description hides denied subagents for the caller", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agent = yield* Agent.Service
          const build = yield* agent.get("build")
          const registry = yield* ToolRegistry.Service
          const description =
            (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === AgentTool.id)?.description ?? ""

          expect(description).toContain("- alpha: Alpha agent")
          expect(description).not.toContain("- zebra: Zebra agent")
        }),
      {
        config: {
          permission: {
            agent: {
              "*": "allow",
              zebra: "deny",
            },
          },
          agent: {
            zebra: {
              description: "Zebra agent",
              mode: "subagent",
            },
            alpha: {
              description: "Alpha agent",
              mode: "subagent",
            },
          },
        },
      },
    ),
  )

  it.live("execute resumes an existing subagent session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({
          parentID: chat.id,
          title: "Existing child",
          createdByAgentTool: true,
          subagentType: "general",
        })
        const tool = yield* AgentTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            subagent_session_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            callID: "call_test_" + Math.random().toString(36).slice(2),
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const kids = yield* sessions.children(chat.id)
        expect(kids).toHaveLength(1)
        expect(kids[0]?.id).toBe(child.id)
        expect(result.metadata.sessionId).toBe(child.id)
        expect(result.output).toContain(`subagent_session_id: ${child.id}`)
        expect(seen?.sessionID).toBe(child.id)
      }),
    ),
  )

  it.live("execute asks by default and skips checks when bypassed", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* AgentTool
        const def = yield* tool.init()
        const calls: unknown[] = []
        const promptOps = stubOps()

        const exec = (extra?: Record<string, any>) =>
          def.execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              callID: "call_test_" + Math.random().toString(36).slice(2),
              extra: { promptOps, ...extra },
              messages: [],
              metadata: () => Effect.void,
              ask: (input) =>
                Effect.sync(() => {
                  calls.push(input)
                }),
            },
          )

        yield* exec()
        yield* exec({ bypassAgentCheck: true })

        expect(calls).toHaveLength(1)
        expect(calls[0]).toEqual({
          permission: "agent",
          patterns: ["general"],
          always: ["*"],
          metadata: {
            description: "inspect bug",
            subagent_type: "general",
          },
        })
      }),
    ),
  )

  it.live("execute marks new child sessions with createdByAgentTool and subagentType", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* AgentTool
        const def = yield* tool.init()
        const promptOps = stubOps()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            callID: "call_test_" + Math.random().toString(36).slice(2),
            extra: { promptOps, bypassAgentCheck: true },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId!)
        expect(child.createdByAgentTool).toBe(true)
        expect(child.subagentType).toBe("general")
      }),
    ),
  )

  it.live("execute fails when subagent_session_id refers to a missing session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* AgentTool
        const def = yield* tool.init()
        const promptOps = stubOps()

        const exit = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "x",
              subagent_type: "general",
              subagent_session_id: "ses_missing",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              callID: "call_resume_missing",
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("execute fails when subagent_session_id refers to a non-agent session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        // Plain child (createdByAgentTool defaults to false) — resume must reject.
        const plainChild = yield* sessions.create({ parentID: chat.id, title: "Plain" })
        const tool = yield* AgentTool
        const def = yield* tool.init()
        const promptOps = stubOps()

        const exit = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "x",
              subagent_type: "general",
              subagent_session_id: plainChild.id,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              callID: "call_resume_plain",
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("execute fails when subagent_type does not match the existing child", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({
          parentID: chat.id,
          title: "Mismatched",
          createdByAgentTool: true,
          subagentType: "reviewer",
        })
        const tool = yield* AgentTool
        const def = yield* tool.init()
        const promptOps = stubOps()

        const exit = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "x",
              subagent_type: "general",
              subagent_session_id: child.id,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              callID: "call_resume_mismatch",
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live.skip("execute creates a child when subagent_session_id does not exist", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* AgentTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            subagent_session_id: "ses_missing",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            callID: "call_test_" + Math.random().toString(36).slice(2),
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const kids = yield* sessions.children(chat.id)
        expect(kids).toHaveLength(1)
        expect(kids[0]?.id).toBe(result.metadata.sessionId!)
        expect(result.metadata.sessionId).not.toBe("ses_missing")
        expect(result.output).toContain(`subagent_session_id: ${result.metadata.sessionId}`)
        expect(seen?.sessionID).toBe(result.metadata.sessionId!)
      }),
    ),
  )

  it.live("execute shapes child permissions for task, todowrite, and primary tools", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const { chat, assistant } = yield* seed()
          const tool = yield* AgentTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          const result = yield* def.execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "reviewer",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              callID: "call_test_" + Math.random().toString(36).slice(2),
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const child = yield* sessions.get(result.metadata.sessionId!)
          expect(child.parentID).toBe(chat.id)
          expect(child.permission).toEqual([
            {
              permission: "agent",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "bash",
              pattern: "*",
              action: "allow",
            },
            {
              permission: "read",
              pattern: "*",
              action: "allow",
            },
          ])
          expect(seen?.tools).toEqual({
            agent: false,
            "enter-worktree": false,
            "exit-worktree": false,
            todowrite: false,
            bash: false,
            read: false,
          })
        }),
      {
        config: {
          agent: {
            reviewer: {
              mode: "subagent",
              permission: {
                agent: "allow",
              },
            },
          },
          experimental: {
            primary_tools: ["bash", "read"],
          },
        },
      },
    ),
  )

  it.live("execute preserves parent external-directory and deny permissions in child sessions", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [
            { permission: "external_directory", pattern: "/tmp/project/*", action: "allow" },
            { permission: "bash", pattern: "rm *", action: "deny" },
            { permission: "read", pattern: "*", action: "allow" },
          ],
        })
        const assistant = yield* seedAssistant(chat.id)
        const tool = yield* AgentTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            callID: "call_test_" + Math.random().toString(36).slice(2),
            extra: { promptOps: stubOps(), bypassAgentCheck: true },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId!)
        expect(child.permission).toContainEqual({
          permission: "external_directory",
          pattern: "/tmp/project/*",
          action: "allow",
        })
        expect(child.permission).toContainEqual({
          permission: "bash",
          pattern: "rm *",
          action: "deny",
        })
        expect(child.permission).not.toContainEqual({
          permission: "read",
          pattern: "*",
          action: "allow",
        })
      }),
    ),
  )

  it.live("execute cancels child session when abort signal fires", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* AgentTool
        const def = yield* tool.init()
        const abort = new AbortController()
        let resolveReady!: (input: SessionPrompt.PromptInput) => void
        let resolveCancelled!: (sessionID: string) => void
        const ready = new Promise<SessionPrompt.PromptInput>((resolve) => {
          resolveReady = resolve
        })
        const cancelled = new Promise<string>((resolve) => {
          resolveCancelled = resolve
        })
        const promptOps: AgentPromptOps = {
          cancel: (sessionID) => Effect.sync(() => resolveCancelled(sessionID)),
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.promise(() => {
              resolveReady(input)
              return cancelled
            }).pipe(Effect.as(reply(input, "cancelled"))),
          wasInterrupted: () => false,
        }

        const fiber = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: abort.signal,
              callID: "call_test_" + Math.random().toString(36).slice(2),
              extra: { promptOps, bypassAgentCheck: true },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.forkChild)

        const input = yield* Effect.promise(() => ready)
        abort.abort()
        expect(yield* Effect.promise(() => cancelled)).toBe(input.sessionID)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  )
})
