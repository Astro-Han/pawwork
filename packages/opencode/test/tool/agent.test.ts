import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Permission } from "../../src/permission"
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

const seedAssistant = Effect.fn("AgentToolTest.seedAssistant")(function* (
  sessionID: SessionID,
  opts?: { variant?: string },
) {
  const session = yield* Session.Service
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: { ...ref, variant: opts?.variant },
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
    variant: opts?.variant,
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

  it.live("execute preserves the caller variant for unpinned subagents", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        const assistant = yield* seedAssistant(chat.id, { variant: "high" })
        const tool = yield* AgentTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        yield* def.execute(
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

        expect(seen?.model).toEqual(ref)
        expect(seen?.variant).toBe("high")
      }),
    ),
  )

  it.live("execute does not preserve the caller variant for model-pinned subagents", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Pinned" })
          const assistant = yield* seedAssistant(chat.id, { variant: "high" })
          const tool = yield* AgentTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          yield* def.execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "scout",
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

          expect(seen?.model).toEqual({
            providerID: ProviderID.make("test"),
            modelID: ModelID.make("pinned-model"),
          })
          expect(seen?.variant).toBeUndefined()
        }),
      {
        config: {
          agent: {
            scout: {
              mode: "subagent",
              model: "test/pinned-model",
            },
          },
        },
      },
    ),
  )

  // #26597: a subagent must not use a tool its caller is denied. The caller's deny rules are
  // forwarded onto the child session at dispatch and are the single source of truth — the boolean
  // `tools` map stays availability-only. We assert the effective ruleset the child runs under (the
  // subagent agent's rules then the child session's, last wins — exactly what the ask gate
  // evaluates). The caller is ctx.agent on a normal LLM dispatch; on a subtask command it's
  // ctx.extra.callerAgent (handleSubtask runs the agent tool as the child). The prompt is stubbed
  // here, so child.permission is the create-time forward; prompt.test.ts covers the rebuild.
  const dispatchChild = (opts: {
    agent: string
    callerAgent?: string
    config?: Partial<Config.Info>
    sessionPermission?: Permission.Ruleset
  }) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const agents = yield* Agent.Service
          const { chat, assistant } = yield* seed()
          if (opts.sessionPermission)
            yield* sessions.setPermission({ sessionID: chat.id, permission: opts.sessionPermission })
          const tool = yield* AgentTool
          const def = yield* tool.init()
          let seenTools: Record<string, boolean> | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seenTools = input.tools) })

          const result = yield* def.execute(
            { description: "inspect bug", prompt: "x", subagent_type: "general" },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: opts.agent,
              abort: new AbortController().signal,
              callID: "call_test_" + Math.random().toString(36).slice(2),
              extra: {
                promptOps,
                bypassAgentCheck: true,
                ...(opts.callerAgent ? { callerAgent: opts.callerAgent } : {}),
              },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const child = yield* sessions.get(result.metadata.sessionId!)
          const subagent = yield* agents.get("general")
          const denies = (key: string) =>
            Permission.evaluate(key, "*", subagent?.permission ?? [], child.permission ?? []).action === "deny"
          return { child, seenTools, denies }
        }),
      opts.config ? { config: opts.config } : undefined,
    )

  it.live("denies edit to the subagent when the caller agent denies edit (#26597)", () =>
    Effect.gen(function* () {
      const { denies } = yield* dispatchChild({
        agent: "restricted",
        config: { agent: { restricted: { permission: { edit: "deny" } } } },
      })
      expect(denies("edit")).toBe(true)
      // Only the denied tool is bound off — bash is untouched.
      expect(denies("bash")).toBe(false)
    }),
  )

  it.live("denies bash to the subagent when the caller agent denies bash (#26597)", () =>
    Effect.gen(function* () {
      // The escalation isn't edit-only: a caller denied bash must not regain it via a subagent
      // (bash can write files and reach the network). edit stays untouched here.
      const { denies } = yield* dispatchChild({
        agent: "restricted",
        config: { agent: { restricted: { permission: { bash: "deny" } } } },
      })
      expect(denies("bash")).toBe(true)
      expect(denies("edit")).toBe(false)
    }),
  )

  it.live("denies every tool to the subagent when the caller agent denies via a wildcard (#26597)", () =>
    Effect.gen(function* () {
      // A read-only-shaped agent denies through "*": deny while allowing read. Forwarding is
      // deny-only (like upstream #26597): the wildcard deny carries over but the read
      // allow-exception does not, so the subagent loses edit, bash AND read. Erring toward deny.
      const { denies } = yield* dispatchChild({
        agent: "restricted",
        config: { agent: { restricted: { permission: { "*": "deny", read: "allow" } } } },
      })
      expect(denies("edit")).toBe(true)
      expect(denies("bash")).toBe(true)
      expect(denies("webfetch")).toBe(true)
      expect(denies("read")).toBe(true)
    }),
  )

  it.live("denies edit to the subagent when the caller session denies edit (#26597)", () =>
    Effect.gen(function* () {
      // A per-session/per-prompt deny on the caller (not the agent definition) must also bind.
      const { denies } = yield* dispatchChild({
        agent: "build",
        sessionPermission: [{ permission: "edit", pattern: "*", action: "deny" }],
      })
      expect(denies("edit")).toBe(true)
    }),
  )

  it.live("honors the subtask caller agent over ctx.agent when denying edit (#26597)", () =>
    Effect.gen(function* () {
      // Subtask dispatch: ctx.agent is the child ("general", can edit) but the real caller
      // ("restricted", edit:deny) arrives via ctx.extra.callerAgent and must win.
      const { denies } = yield* dispatchChild({
        agent: "general",
        callerAgent: "restricted",
        config: { agent: { restricted: { permission: { edit: "deny" } } } },
      })
      expect(denies("edit")).toBe(true)
    }),
  )

  it.live("leaves tools enabled for the subagent when the caller can use them (#26597)", () =>
    Effect.gen(function* () {
      // build can edit and run bash (its "rm *" pattern-deny must not flatten to a whole-tool
      // deny), so neither edit nor bash is bound off on the subagent.
      const { denies } = yield* dispatchChild({ agent: "build" })
      expect(denies("edit")).toBe(false)
      expect(denies("bash")).toBe(false)
    }),
  )

  it.live("forwards the caller agent's scoped deny onto the child session (#26597)", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          // A scoped deny (edit denied on /secret/** while allowed elsewhere) can't be expressed in
          // the boolean tools map. The agent tool forwards it onto the child session at create as a
          // real rule, so the child inherits the exact shape — denied on /secret, allowed elsewhere
          // — and the map never force-disables edit.
          const sessions = yield* Session.Service
          const agents = yield* Agent.Service
          const { chat, assistant } = yield* seed()
          const caller = yield* agents.get("restricted")
          // The caller is genuinely scope-denied: last-match-wins makes the trailing /secret deny
          // beat the "*" allow on /secret, but not elsewhere.
          expect(Permission.evaluate("edit", "/secret/x", caller?.permission ?? []).action).toBe("deny")
          expect(Permission.evaluate("edit", "/elsewhere/x", caller?.permission ?? []).action).toBe("allow")

          const tool = yield* AgentTool
          const def = yield* tool.init()
          let seenTools: Record<string, boolean> | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seenTools = input.tools) })

          const result = yield* def.execute(
            { description: "inspect bug", prompt: "x", subagent_type: "general" },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "restricted",
              abort: new AbortController().signal,
              callID: "call_test_" + Math.random().toString(36).slice(2),
              extra: { promptOps, bypassAgentCheck: true },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const child = yield* sessions.get(result.metadata.sessionId!)
          const subagent = yield* agents.get("general")
          // The child inherits the scoped deny: denied on /secret, still able to edit elsewhere.
          expect(
            Permission.evaluate("edit", "/secret/x", subagent?.permission ?? [], child.permission ?? []).action,
          ).toBe("deny")
          expect(
            Permission.evaluate("edit", "/elsewhere/x", subagent?.permission ?? [], child.permission ?? []).action,
          ).toBe("allow")
          // The caller can edit elsewhere, so edit isn't force-disabled in the tools map.
          expect(seenTools?.edit).toBeUndefined()
        }),
      { config: { agent: { restricted: { permission: { edit: { "*": "allow", "/secret/**": "deny" } } } } } },
    ),
  )

  it.live("re-forwards the current caller's deny onto a resumed subagent session (#26597)", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          // Resume (subagent_session_id) skips sessions.create. A child created earlier by a
          // permissive caller, then resumed by a now-restricted caller (edit:deny — e.g. the
          // session switched to Plan Mode), must pick up the restrictive caller's deny; otherwise
          // resume bypasses the escalation guard.
          const sessions = yield* Session.Service
          const agents = yield* Agent.Service
          const { chat, assistant } = yield* seed()
          // Pre-existing child as if created by a permissive caller — no edit deny.
          const child = yield* sessions.create({
            parentID: chat.id,
            title: "Existing child",
            createdByAgentTool: true,
            subagentType: "general",
          })
          const subagent = yield* agents.get("general")
          // Before resume the child can edit (general inherits the default "*": allow).
          expect(Permission.evaluate("edit", "*", subagent?.permission ?? [], child.permission ?? []).action).toBe(
            "allow",
          )
          const tool = yield* AgentTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            { description: "inspect bug", prompt: "x", subagent_type: "general", subagent_session_id: child.id },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "restricted",
              abort: new AbortController().signal,
              callID: "call_test_" + Math.random().toString(36).slice(2),
              extra: { promptOps: stubOps({ text: "resumed" }), bypassAgentCheck: true },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(result.metadata.sessionId).toBe(child.id)
          const after = yield* sessions.get(child.id)
          expect(Permission.evaluate("edit", "*", subagent?.permission ?? [], after.permission ?? []).action).toBe(
            "deny",
          )
        }),
      { config: { agent: { restricted: { permission: { edit: "deny" } } } } },
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
          // The shaping logic contributes these four rules (nested-agent deny, todowrite deny,
          // and the two primary-tool allows). #26597 also prepends the caller agent's forwarded
          // deny rules, so assert the shaped rules are present rather than an exact ruleset.
          expect(child.permission).toContainEqual({ permission: "agent", pattern: "*", action: "deny" })
          expect(child.permission).toContainEqual({ permission: "todowrite", pattern: "*", action: "deny" })
          expect(child.permission).toContainEqual({ permission: "bash", pattern: "*", action: "allow" })
          expect(child.permission).toContainEqual({ permission: "read", pattern: "*", action: "allow" })
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
