import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionDiagnostics } from "../../src/session/diagnostics"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { TurnChange } from "../../src/session/turn-change"
import { Snapshot } from "../../src/snapshot"
import { Log } from "../../src/util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    artifacts: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

// Use "opencode" as the providerID so classifyRetry() can detect
// FreeUsageLimitError (which requires providerID === ProviderID.opencode).
const opencodeRef = {
  providerID: ProviderID.opencode,
  modelID: ModelID.make("opencode-model"),
}

function opencodeCfg(url: string) {
  return {
    provider: {
      opencode: {
        name: "OpenCode",
        id: "opencode",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "opencode-model": {
            id: "opencode-model",
            name: "OpenCode Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: {
          apiKey: "test-key",
          baseURL: url,
        },
      },
    },
  }
}

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  TurnChange.defaultLayer,
  status,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps)),
)

const it = testEffect(env)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: opencodeRef,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: opencodeRef.modelID,
    providerID: opencodeRef.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("halt routes free_quota_exhausted to rate_limit_blocked status", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const sts = yield* SessionStatus.Service

        // Queue a 429 with FreeUsageLimitError body — classifyRetry will detect this
        // as free_quota_exhausted because providerID === "opencode".
        yield* llm.error(429, { error: { type: "FreeUsageLimitError" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "rate limit")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(opencodeRef.providerID, opencodeRef.modelID)

        // Spy on Session.Event.Error — this must NOT fire for free_quota_exhausted.
        const sessionErrors: string[] = []
        const off = yield* bus.subscribeCallback(Session.Event.Error, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          sessionErrors.push(evt.properties.error?.name ?? "unknown")
        })

        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const result = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: opencodeRef.providerID, modelID: opencodeRef.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "rate limit" }],
          tools: {},
        })

        off()

        // Invariant 1: process() returns "stop" (ctx.blocked is set).
        expect(result).toBe("stop")

        // Invariant 2: SessionStatus becomes rate_limit_blocked.
        const state = yield* sts.get(chat.id)
        expect(state.type).toBe("rate_limit_blocked")
        if (state.type === "rate_limit_blocked") {
          expect(state.classification.kind).toBe("free_quota_exhausted")
          expect(state.classification.providerID).toBe("opencode")
        }

        // Invariant 3: Session.Event.Error was NOT published (no OS notification toast).
        expect(sessionErrors).toHaveLength(0)

        // Invariant 4: assistantMessage.error was NOT written (no generic error card).
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => opencodeCfg(url) },
  ),
)

it.live("halt cross-call: free_quota then generic error does NOT stale-classify", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const sts = yield* SessionStatus.Service

        // First call: free_quota_exhausted → rate_limit_blocked, ctx.blocked = true.
        yield* llm.error(429, { error: { type: "FreeUsageLimitError" } })

        const chat = yield* session.create({})
        const parent1 = yield* user(chat.id, "turn one")
        const msg1 = yield* assistant(chat.id, parent1.id, path.resolve(dir))
        const mdl = yield* provider.getModel(opencodeRef.providerID, opencodeRef.modelID)

        const handle1 = yield* processors.create({
          assistantMessage: msg1,
          sessionID: chat.id,
          model: mdl,
        })

        yield* handle1.process({
          user: {
            id: parent1.id,
            sessionID: chat.id,
            role: "user",
            time: parent1.time,
            agent: parent1.agent,
            model: { providerID: opencodeRef.providerID, modelID: opencodeRef.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "turn one" }],
          tools: {},
        })

        const stateAfterFirst = yield* sts.get(chat.id)
        expect(stateAfterFirst.type).toBe("rate_limit_blocked")

        // Second call: non-classifiable 400 error → generic halt path.
        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const parent2 = yield* user(chat.id, "turn two")
        const msg2 = yield* assistant(chat.id, parent2.id, path.resolve(dir))

        const sessionErrors: string[] = []
        const off = yield* bus.subscribeCallback(Session.Event.Error, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          sessionErrors.push(evt.properties.error?.name ?? "unknown")
        })

        const handle2 = yield* processors.create({
          assistantMessage: msg2,
          sessionID: chat.id,
          model: mdl,
        })

        yield* handle2.process({
          user: {
            id: parent2.id,
            sessionID: chat.id,
            role: "user",
            time: parent2.time,
            agent: parent2.agent,
            model: { providerID: opencodeRef.providerID, modelID: opencodeRef.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "turn two" }],
          tools: {},
        })

        off()

        // Second halt must enter generic path: error written, status idle.
        const stateAfterSecond = yield* sts.get(chat.id)
        expect(stateAfterSecond.type).toBe("idle")
        expect(handle2.message.error).toBeDefined()
        // Session.Event.Error must have fired for the generic path.
        expect(sessionErrors.length).toBeGreaterThan(0)
      }),
    { git: true, config: (url) => opencodeCfg(url) },
  ),
)
