import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect"
import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { LSP } from "../../src/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "../../src/provider/provider"
import { Env } from "../../src/env"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Todo } from "../../src/session/todo"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import {
  reconcileTitleGenerationStateAfterCompletion,
  SessionPrompt,
  titleGenerationStateAtAbort,
} from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { beginLifecycleClose } from "../../src/session/lifecycle-provenance"
import { SubagentRun } from "../../src/session/subagent-run"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { TurnChange } from "../../src/session/turn-change"
import { Skill } from "../../src/skill"
import { Settings } from "../../src/settings"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "../../src/shell/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "../../src/tool/registry"
import { Automation } from "../../src/automation"
import { AutomationScheduler } from "../../src/automation/scheduler"
import { WebSearchAuth } from "../../src/tool/websearch-auth"
import { Truncate } from "../../src/tool/truncate"
import { Log } from "@opencode-ai/core/util/log"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed({ kind: "empty", sessionID: "ses_test" as any }),
    artifacts: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const cancelRaceCheckpointTimeout = "5 seconds"

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return withShell("/bin/sh", fx)
}

function withShell<A, E, R>(shell: string, fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = shell
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: MessageV2.Part[]) {
  return parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
}

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }
type ErrorToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateError }

function completedTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function flattenRequestText(input: Record<string, unknown>) {
  const messages = (input as { messages?: unknown[] }).messages ?? []
  return messages
    .flatMap((message) => {
      const content = (message as { content?: unknown }).content
      if (typeof content === "string") return [content]
      if (Array.isArray(content)) {
        return content.flatMap((part) => {
          if (typeof part === "string") return [part]
          if (part && typeof part === "object" && "text" in part) return [String((part as { text: unknown }).text)]
          return []
        })
      }
      return []
    })
    .join("\n")
}

function requestTextContaining(inputs: Record<string, unknown>[], needle: string) {
  const match = inputs.find((input) => flattenRequestText(input).includes(needle))
  if (!match) throw new Error(`Missing provider request containing: ${needle}`)
  return flattenRequestText(match)
}

function requestToolNames(input: Record<string, unknown>) {
  const tools = Array.isArray(input.tools) ? input.tools : []
  return tools.flatMap((tool) => {
    const fn =
      tool && typeof tool === "object" && "function" in tool && tool.function && typeof tool.function === "object"
        ? tool.function
        : undefined
    if (!fn || !("name" in fn) || typeof fn.name !== "string") return []
    return [fn.name]
  })
}

function envValue(text: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = text.match(new RegExp(`^  ${escaped}: (.+)$`, "m"))
  if (!match) throw new Error(`Missing env field: ${label}`)
  return match[1]
}

describe("title generation diagnostics helpers", () => {
  test("maps abort-time title generation states", () => {
    expect(titleGenerationStateAtAbort(undefined, 10)).toBe("not_started")
    expect(titleGenerationStateAtAbort({ startedAt: 1 }, 10)).toBe("in_flight")
    expect(titleGenerationStateAtAbort({ startedAt: 1, completedAt: 15 }, 10)).toBe("in_flight")
    expect(titleGenerationStateAtAbort({ startedAt: 1, completedAt: 9 }, 10)).toBe("completed_before_abort")
  })

  test("upgrades in-flight abort state after title completes", () => {
    expect(
      reconcileTitleGenerationStateAfterCompletion({
        state: "in_flight",
        abortRecordedAt: 10,
        completedAt: 15,
      }),
    ).toBe("completed_after_abort")
    expect(
      reconcileTitleGenerationStateAfterCompletion({
        state: "in_flight",
        abortRecordedAt: 10,
        completedAt: 10,
      }),
    ).toBe("completed_before_abort")
    expect(
      reconcileTitleGenerationStateAfterCompletion({
        state: "completed_before_abort",
        abortRecordedAt: 10,
        completedAt: 9,
      }),
    ).toBe("completed_before_abort")
  })
})

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
    shutdownAll: () => Effect.succeed(void 0),
    invalidate: () => Effect.succeed(void 0),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const httpWithExaQuotaFixture = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const base = yield* HttpClient.HttpClient
    return HttpClient.make((request) => {
      if (request.url.startsWith("https://mcp.exa.ai/mcp")) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("quota exceeded", { status: 429 })))
      }
      return base.execute(request)
    })
  }),
).pipe(Layer.provide(FetchHttpClient.layer))

function makeHttp(httpLayer: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer) {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    TurnChange.defaultLayer,
    status,
  ).pipe(Layer.provideMerge(infra))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(Settings.defaultLayer),
    Layer.provide(WebSearchAuth.defaultLayer),
    Layer.provide(httpLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(SubagentRun.defaultLayer),
    Layer.provide(Automation.defaultLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps))
  const compact = SessionCompaction.layer.pipe(Layer.provideMerge(proc), Layer.provideMerge(deps))
  return Layer.mergeAll(
    TestLLMServer.layer,
    SessionPrompt.layer.pipe(
      Layer.provide(SessionRevert.defaultLayer),
      Layer.provide(summary),
      Layer.provideMerge(run),
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(registry),
      Layer.provideMerge(trunc),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(SystemPrompt.defaultLayer),
      Layer.provideMerge(deps),
    ),
  ).pipe(Layer.provide(summary))
}

// Windows runner is consistently slow on Effect-fiber + SQLite + tmpdir-server
// setup; default the live() timeout instead of bandaging individual tests.
// An explicit third-arg timeout still overrides.
const defaultLiveTimeout = process.platform === "win32" ? 10_000 : 3_000
const slowWindowsLiveTimeout = process.platform === "win32" ? 30_000 : undefined

function withDefaultLiveTimeout<
  T extends { live: ((...args: any[]) => any) & { only: any; skip: any } },
>(raw: T): T {
  const wrap = (fn: (...args: any[]) => any) =>
    (name: any, body: any, opts?: any) => fn(name, body, opts ?? defaultLiveTimeout)
  const live = wrap(raw.live) as T["live"]
  live.only = wrap(raw.live.only)
  live.skip = wrap(raw.live.skip)
  return { ...raw, live }
}

const it = withDefaultLiveTimeout(testEffect(makeHttp()))
const itWithExaQuota = withDefaultLiveTimeout(testEffect(makeHttp(httpWithExaQuotaFixture)))
const unix = process.platform !== "win32" ? it.live : it.live.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
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
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

const imageCfg = {
  ...cfg,
  provider: {
    ...cfg.provider,
    test: {
      ...cfg.provider.test,
      models: {
        ...cfg.provider.test.models,
        "test-model": {
          ...cfg.provider.test.models["test-model"],
          modalities: {
            input: ["text", "image"] as ("text" | "image")[],
            output: ["text"] as "text"[],
          },
        },
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function retainedTailCfg(url: string) {
  return {
    ...providerCfg(url),
    compaction: {
      tail_turns: 1,
      preserve_recent_tokens: 8_000,
    },
  }
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
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

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
      status: "completed",
      recent_events: [],
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

it.live("loop exits immediately when last assistant has stop finish", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
      expect(yield* llm.calls).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop compacts a finished assistant turn before exiting when it overflows", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Overflowed finished turn" })
        const seeded = yield* seed(chat.id, { finish: "stop" })
        yield* sessions.updateMessage({
          ...seeded.assistant,
          tokens: { input: 95_000, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        yield* llm.text("## Goal\n- Compacted finished overflow turn")

        const result = yield* prompt.loop({ sessionID: chat.id })
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const compactionPart = messages
          .flatMap((message) => message.parts)
          .find((part): part is MessageV2.CompactionPart => part.type === "compaction")
        const summary = messages.find((message) => message.info.role === "assistant" && message.info.summary === true)
        const syntheticContinue = messages.find(
          (message) =>
            message.info.role === "user" &&
            message.parts.some(
              (part) => part.type === "text" && part.synthetic && part.text.includes("Continue if you have next steps"),
            ),
        )

        expect(yield* llm.calls).toBeGreaterThanOrEqual(1)
        expect(compactionPart).toBeDefined()
        expect(compactionPart?.overflow).not.toBe(true)
        expect(summary?.info.role).toBe("assistant")
        expect(result.info.role).toBe("assistant")
        expect(syntheticContinue).toBeUndefined()

        const callsAfterCompaction = yield* llm.calls
        const secondResult = yield* prompt.loop({ sessionID: chat.id })
        expect(secondResult.info.role).toBe("assistant")
        expect(yield* llm.calls).toBe(callsAfterCompaction)
      }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop continues a mid-task turn after auto compaction interrupts it", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Interrupted mid-task turn" })
        // The overflowing turn stopped on a tool-calls step (mid-task), so there
        // is unfinished work the loop must resume after compacting — unlike a
        // cleanly finished turn, which should compact and wait.
        const seeded = yield* seed(chat.id, { finish: "tool-calls" })
        yield* sessions.updateMessage({
          ...seeded.assistant,
          tokens: { input: 95_000, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        yield* llm.text("## Goal\n- Compacted mid-task turn")
        yield* llm.text("resumed the interrupted work")

        const result = yield* prompt.loop({ sessionID: chat.id })
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const compactionPart = messages
          .flatMap((message) => message.parts)
          .find((part): part is MessageV2.CompactionPart => part.type === "compaction")
        const syntheticContinue = messages.find(
          (message) =>
            message.info.role === "user" &&
            message.parts.some(
              (part) => part.type === "text" && part.synthetic && part.text.includes("Continue if you have next steps"),
            ),
        )

        expect(compactionPart).toBeDefined()
        expect(compactionPart?.overflow).not.toBe(true)
        // Mid-task interruption: compaction injects the synthetic continue and the
        // loop resumes (a second LLM call) instead of stopping at the summary.
        expect(syntheticContinue).toBeDefined()
        expect(yield* llm.calls).toBeGreaterThanOrEqual(2)
        expect(result.info.role).toBe("assistant")
      }),
    { git: true, config: providerCfg },
  ),
)

it.live("finished compaction with retained tail does not compact that tail again", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Retained finished tail" })
        const first = yield* user(chat.id, "first request")
        const firstAssistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: first.id,
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: dir, root: dir },
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
          finish: "stop",
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: firstAssistant.id,
          sessionID: chat.id,
          type: "text",
          text: "first answer",
        })
        const second = yield* user(chat.id, "second request")
        const secondAssistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: second.id,
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: dir, root: dir },
          tokens: { input: 95_000, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
          finish: "stop",
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: secondAssistant.id,
          sessionID: chat.id,
          type: "text",
          text: "second answer",
        })
        yield* llm.text("## Goal\n- Compacted first turn")
        yield* llm.text("## Goal\n- Unexpected second compaction")

        const result = yield* prompt.loop({ sessionID: chat.id })
        const callsAfterFirstLoop = yield* llm.calls
        const secondResult = yield* prompt.loop({ sessionID: chat.id })
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const filtered = yield* MessageV2.filterCompactedEffect(chat.id)
        const compactionParts = messages.flatMap((message) => message.parts).filter((part) => part.type === "compaction")
        const syntheticContinue = messages.find(
          (message) =>
            message.info.role === "user" &&
            message.parts.some(
              (part) => part.type === "text" && part.synthetic && part.text.includes("Continue if you have next steps"),
            ),
        )

        expect(result.info.role).toBe("assistant")
        expect(secondResult.info.role).toBe("assistant")
        expect(callsAfterFirstLoop).toBe(1)
        expect(yield* llm.calls).toBe(1)
        expect(compactionParts).toHaveLength(1)
        expect(compactionParts[0]).toMatchObject({ tail_start_id: second.id })
        expect(syntheticContinue).toBeUndefined()
        expect(filtered.map((message) => message.info.id)).toEqual([
          compactionParts[0]!.messageID,
          result.info.id,
          second.id,
          secondAssistant.id,
        ])
      }),
    { git: true, config: retainedTailCfg },
  ),
)

it.live("loop calls LLM and returns assistant message", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const userMsg = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      const parts = result.parts.filter((p) => p.type === "text")
      expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("prompt records lifecycle wait diagnostics on the queued user message", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Lifecycle wait diagnostics",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const releaseClose = beginLifecycleClose([dir])
        const fiber = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            parts: [{ type: "text", text: "hello" }],
          })
          .pipe(Effect.forkChild)

        try {
          let user: MessageV2.WithParts | undefined
          const deadline = Date.now() + 1000
          while (Date.now() < deadline) {
            const pending = yield* sessions.messages({ sessionID: chat.id })
            user = pending.find((message) => message.info.role === "user")
            if (user) break
            yield* Effect.sleep("5 millis")
          }
          expect(user?.info.role).toBe("user")
          if (user?.info.role === "user") {
            expect(user.info.diagnostics?.run_lifecycle?.map((event) => event.type)).toEqual([
              "user_message_saved",
              "run_wait_started",
            ])
          }

          yield* llm.text("world")
          releaseClose()
          expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)

          const final = yield* sessions.messages({ sessionID: chat.id })
          const recorded = final.find((message) => message.info.role === "user")
          expect(recorded?.info.role).toBe("user")
          if (recorded?.info.role === "user") {
            expect(recorded.info.diagnostics?.run_lifecycle?.map((event) => event.type)).toEqual([
              "user_message_saved",
              "run_wait_started",
              "run_wait_ended",
            ])
          }
        } finally {
          releaseClose()
        }
      }),
    { git: true, config: providerCfg },
  ),
)


it.live("provider env matches assistant path for an active worktree", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Execution context snapshot",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const activeDirectory = path.join(dir, ".worktrees", "pawwork", "ctx-snapshot")
        yield* Effect.promise(() => fs.mkdir(activeDirectory, { recursive: true }))
        yield* sessions.updateExecutionContext({
          sessionID: session.id,
          activeWorktree: {
            directory: activeDirectory,
            name: "ctx-snapshot",
            branch: "pawwork/ctx-snapshot",
            source: "created",
          },
        })

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "check execution context snapshot" }],
        })
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: session.id })
        if (result.info.role !== "assistant") throw new Error("Expected assistant message")

        const requestText = requestTextContaining(yield* llm.inputs, "check execution context snapshot")
        expect(envValue(requestText, "Working directory")).toBe(result.info.path.cwd)
        expect(envValue(requestText, "Workspace root folder")).toBe(result.info.path.root)
        expect(result.info.path.cwd).toBe(activeDirectory)
        expect(result.info.path.root).toBe(dir)
      }),
    { git: true, config: providerCfg },
  ),
)

it.live("post-compaction user continuation keeps env in the active worktree", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const compact = yield* SessionCompaction.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Compaction execution context",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const activeDirectory = path.join(dir, ".worktrees", "pawwork", "ctx-compact")
        yield* Effect.promise(() => fs.mkdir(activeDirectory, { recursive: true }))
        yield* sessions.updateExecutionContext({
          sessionID: session.id,
          activeWorktree: {
            directory: activeDirectory,
            name: "ctx-compact",
            branch: "pawwork/ctx-compact",
            source: "created",
          },
        })

        const priorUser = yield* user(session.id, "work before compaction")
        const priorAssistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: priorUser.id,
          sessionID: session.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: activeDirectory, root: dir },
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
          finish: "stop",
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: priorAssistant.id,
          sessionID: session.id,
          type: "text",
          text: "finished work before compaction",
        })

        const compactionParent = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: compactionParent.id,
          sessionID: session.id,
          type: "compaction",
          auto: true,
        })

        yield* llm.text("## Goal\n- Continue from compacted worktree context")
        const compacted = yield* compact.process({
          parentID: compactionParent.id,
          messages: yield* MessageV2.filterCompactedEffect(session.id),
          sessionID: session.id,
          auto: true,
        })
        expect(compacted).toBe("continue")

        const messagesAfterCompaction = yield* sessions.messages({ sessionID: session.id })
        const summaryMessage = messagesAfterCompaction.find(
          (message) => message.info.role === "assistant" && message.info.summary === true,
        )
        if (!summaryMessage || summaryMessage.info.role !== "assistant") {
          throw new Error("Missing compaction summary assistant message")
        }
        expect(summaryMessage.info.path.cwd).toBe(activeDirectory)
        expect(summaryMessage.info.path.root).toBe(dir)

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "continue after compaction" }],
        })
        yield* llm.text("continued after compaction")
        const result = yield* prompt.loop({ sessionID: session.id })
        if (result.info.role !== "assistant") throw new Error("Expected assistant message")

        const requestText = requestTextContaining(yield* llm.inputs, "continue after compaction")
        expect(envValue(requestText, "Working directory")).toBe(activeDirectory)
        expect(envValue(requestText, "Workspace root folder")).toBe(dir)
        expect(result.info.path.cwd).toBe(activeDirectory)
        expect(result.info.path.root).toBe(dir)
      }),
    { git: true, config: providerCfg },
  ),
)

it.live("static loop returns assistant text through local provider", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Prompt provider",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })

      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("static loop consumes queued replies across turns", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Prompt provider turns",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello one" }],
      })

      yield* llm.text("world one")

      const first = yield* prompt.loop({ sessionID: session.id })
      expect(first.info.role).toBe("assistant")
      expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello two" }],
      })

      yield* llm.text("world two")

      const second = yield* prompt.loop({ sessionID: session.id })
      expect(second.info.role).toBe("assistant")
      expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

      expect(yield* llm.hits).toHaveLength(2)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop continues when finish is tool-calls", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.tool("first", { value: "first" })
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop activates automate_manage through tool_info before invoking it", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      try {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Automation manage activation",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "List my existing PawWork Automations." }],
        })

        yield* llm.tool("tool_info", { name: "automate_manage" })
        yield* llm.tool("automate_manage", { action: "list" })
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: session.id })
        expect(result.info.role).toBe("assistant")

        const requests = yield* llm.inputs
        expect(requests.length).toBeGreaterThanOrEqual(2)
        const [firstRequest, secondRequest] = requests
        expect(requestToolNames(firstRequest)).toContain("tool_info")
        expect(requestToolNames(firstRequest)).not.toContain("automate_manage")
        expect(requestToolNames(secondRequest)).toContain("automate_manage")

        const allMessages = yield* MessageV2.filterCompactedEffect(session.id)
        const toolParts = allMessages.flatMap((message) =>
          message.parts.filter((part): part is MessageV2.ToolPart => part.type === "tool"),
        )
        const toolInfo = toolParts.find((part) => part.tool === "tool_info")
        const automateManage = toolParts.find((part) => part.tool === "automate_manage")
        expect(toolInfo?.state.status).toBe("completed")
        expect(automateManage?.state.status).toBe("completed")
        if (automateManage?.state.status === "completed") {
          expect(JSON.parse(automateManage.state.output)).toEqual({ items: [] })
        }
      } finally {
        AutomationScheduler.stopProcess({ stopRuns: false })
      }
    }),
    { git: true, config: providerCfg },
  ),
)

itWithExaQuota.live("websearch failures surface Exa recovery copy instead of cleanup abort", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Websearch failure",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "search the web" }],
        })

        yield* llm.tool("websearch", { query: "latest PawWork release" })

        const result = yield* prompt.loop({ sessionID: session.id })
        expect(result.info.role).toBe("assistant")
        const allMessages = yield* MessageV2.filterCompactedEffect(session.id)
        const allParts = allMessages.flatMap((m) => m.parts)
        const tool = allParts.find((part): part is ErrorToolPart => {
          return part.type === "tool" && part.tool === "websearch" && part.state.status === "error"
        })
        expect(tool).toBeDefined()
        expect(tool?.state.error).toContain("The bundled Web Search quota was reached")
        expect(tool?.state.error).not.toContain("Tool execution aborted")
        expect(tool?.state.metadata?.interrupted).toBeUndefined()
        expect(tool?.state.metadata?.webSearch?.failure).toMatchObject({
          kind: "quota_exceeded",
          source: "anonymous",
          status: 429,
        })
      }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop gate records same-step repeated tool errors without block or stop", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Loop gate",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "read missing" }],
        })

        // Always read the same nonexistent path so input + (fallback target) hashes are stable.
        const filePath = path.join(dir, "loop-gate-nonexistent.txt")
        const input = { filePath }
        let sameStep = reply()
        for (let i = 0; i < 7; i++) sameStep = sameStep.tool("read", input)
        yield* llm.push(sameStep)
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: session.id })
        expect(result.info.role).toBe("assistant")

        const allMessages = yield* MessageV2.filterCompactedEffect(session.id)
        const allParts = allMessages.flatMap((m) => m.parts)
        const errorParts = allParts.filter(
          (part): part is ErrorToolPart => part.type === "tool" && part.state.status === "error",
        )
        const completedParts = allParts.filter(
          (part): part is CompletedToolPart => part.type === "tool" && part.state.status === "completed",
        )
        expect(completedParts).toHaveLength(0)

        const blockParts = errorParts.filter((p) => p.state.metadata?.diagnostics?.loop?.loopAction === "block")
        const stopParts = errorParts.filter((p) => p.state.metadata?.diagnostics?.loop?.loopAction === "stop")
        expect(blockParts).toHaveLength(0)
        expect(stopParts).toHaveLength(0)
        expect(errorParts[0].state.metadata?.diagnostics?.failure?.errorKind).toBe("environment")

        const requests = yield* llm.inputs
        // Extract user/system message text fields rather than stringifying the whole request
        // shape, so the assertion does not break when ai-sdk request schema gets unrelated
        // fields (timestamps, ids, model parameters).
        const flattenedText = requests.flatMap((r) => {
          const msgs = (r as { messages?: unknown[] }).messages ?? []
          return msgs.flatMap((m) => {
            const content = (m as { content?: unknown }).content
            if (typeof content === "string") return [content]
            if (Array.isArray(content)) {
              return content.flatMap((c) => {
                if (typeof c === "string") return [c]
                if (c && typeof c === "object" && "text" in c) return [String((c as { text: unknown }).text)]
                return []
              })
            }
            return []
          })
        })
        expect(
          flattenedText.some(
            (t) =>
              t.includes("repeated the same tool input 3 times") ||
              t.includes("failed against the same target multiple times"),
          ),
        ).toBe(false)
      }),
    { git: true, config: providerCfg },
  ),
  slowWindowsLiveTimeout,
)

it.live("loop gate blocks repeated tool errors across model steps", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Loop gate cross-step",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "read missing repeatedly" }],
        })

        const input = { filePath: path.join(dir, "loop-gate-cross-step-missing.txt") }
        for (let i = 0; i < 4; i++) yield* llm.tool("read", input)
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: session.id })
        expect(result.info.role).toBe("assistant")

        const allMessages = yield* MessageV2.filterCompactedEffect(session.id)
        const allParts = allMessages.flatMap((m) => m.parts)
        const blockParts = allParts.filter(
          (part): part is ErrorToolPart =>
            part.type === "tool" &&
            part.state.status === "error" &&
            part.state.metadata?.diagnostics?.loop?.loopAction === "block",
        )
        expect(blockParts).toHaveLength(1)
        expect(blockParts[0].state.metadata?.diagnostics?.loop?.loopCompletedFailures).toBe(3)
        expect(blockParts[0].state.metadata?.diagnostics?.loop?.attemptedInput).toEqual(input)
      }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop gate allows successful read calls for different ranges of the same file", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Loop gate read ranges",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const file = path.join(dir, "loop-gate-read-ranges.txt")
        yield* Effect.promise(() =>
          Bun.write(
            file,
            Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n"),
          ),
        )

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "read ranges" }],
        })
        for (const offset of [1, 10, 20, 30]) {
          yield* llm.tool("read", { filePath: file, offset, limit: 5 })
        }
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: session.id })
        expect(result.info.role).toBe("assistant")

        const allMessages = yield* MessageV2.filterCompactedEffect(session.id)
        const allParts = allMessages.flatMap((m) => m.parts)
        const completedReadParts = allParts.filter(
          (part): part is CompletedToolPart =>
            part.type === "tool" && part.tool === "read" && part.state.status === "completed",
        )
        const loopGateParts = allParts.filter(
          (part): part is ErrorToolPart =>
            part.type === "tool" &&
            part.state.status === "error" &&
            part.state.metadata?.diagnostics?.loop?.loopAction !== undefined,
        )

        expect(completedReadParts).toHaveLength(4)
        expect(loopGateParts).toHaveLength(0)
        expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
      }),
    { git: true, config: providerCfg },
  ),
)

unix("bash file mutation resets successful exact-input loop gating", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Loop gate bash mutation patch",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const file = path.join(dir, "loop-gate-bash-mutation.txt")

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "write file with bash" }],
        })
        const input = {
          command: `printf 'changed\\n' > ${JSON.stringify(file)} && printf 'ok\\n'`,
          description: "write test file",
        }
        for (let i = 0; i < 4; i++) yield* llm.tool("bash", input)
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: session.id })
        expect(result.info.role).toBe("assistant")

        const allMessages = yield* MessageV2.filterCompactedEffect(session.id)
        const allParts = allMessages.flatMap((m) => m.parts)
        const completedBashParts = allParts.filter(
          (part): part is CompletedToolPart =>
            part.type === "tool" && part.tool === "bash" && part.state.status === "completed",
        )
        const loopGateParts = allParts.filter(
          (part): part is ErrorToolPart =>
            part.type === "tool" &&
            part.state.status === "error" &&
            part.state.metadata?.diagnostics?.loop?.loopAction !== undefined,
        )
        const patchParts = allParts.filter((part): part is MessageV2.PatchPart => part.type === "patch")

        expect(completedBashParts).toHaveLength(4)
        expect(loopGateParts).toHaveLength(0)
        expect(patchParts.length).toBeGreaterThan(0)
        expect(patchParts.flatMap((part) => part.files).some((item) => item.endsWith("loop-gate-bash-mutation.txt"))).toBe(
          true,
        )
        expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
      }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop gate stops repeated tool errors across model steps", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Loop gate failure stop",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "read missing until stop" }],
        })

        const input = { filePath: path.join(dir, "loop-gate-failure-stop-missing.txt") }
        for (let i = 0; i < 5; i++) yield* llm.tool("read", input)
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: session.id })
        expect(result.info.role).toBe("assistant")

        const allMessages = yield* MessageV2.filterCompactedEffect(session.id)
        const allParts = allMessages.flatMap((m) => m.parts)
        const blockParts = allParts.filter(
          (part): part is ErrorToolPart =>
            part.type === "tool" &&
            part.state.status === "error" &&
            part.state.metadata?.diagnostics?.loop?.loopAction === "block",
        )
        const stopParts = allParts.filter(
          (part): part is ErrorToolPart =>
            part.type === "tool" &&
            part.state.status === "error" &&
            part.state.metadata?.diagnostics?.loop?.loopAction === "stop",
        )

        expect(blockParts).toHaveLength(1)
        expect(stopParts).toHaveLength(1)
        expect(stopParts[0].state.metadata?.diagnostics?.loop?.outcome).toBe("failure")
        expect(stopParts[0].state.metadata?.diagnostics?.loop?.loopCompletedCount).toBe(3)
        expect(stopParts[0].state.metadata?.diagnostics?.loop?.loopOccurrenceCount).toBe(5)
        expect(stopParts[0].state.metadata?.diagnostics?.loop?.attemptedInput).toEqual(input)
        expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(false)
      }),
    { git: true, config: providerCfg },
  ),
)

it.live("glob tool keeps instance context during prompt runs", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Glob context",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const file = path.join(dir, "probe.txt")
        yield* Effect.promise(() => Bun.write(file, "probe"))

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "find text files" }],
        })
        yield* llm.tool("glob", { pattern: "**/*.txt" })
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: session.id })
        expect(result.info.role).toBe("assistant")

        const msgs = yield* MessageV2.filterCompactedEffect(session.id)
        const tool = msgs
          .flatMap((msg) => msg.parts)
          .find(
            (part): part is CompletedToolPart =>
              part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
          )
        if (!tool) return

        expect(tool.state.output).toContain(file)
        expect(tool.state.output).not.toContain("No context found for instance")
        expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
      }),
    { git: true, config: providerCfg },
  ),
)

it.live("text file part does not promote PDF attachment when model lacks PDF input", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const pdf = path.join(dir, "guide.pdf")
        const pdfUrl = pathToFileURL(pdf).href
        yield* Effect.promise(() => Bun.write(pdf, "%PDF-1.7\n"))

        const msg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "read this PDF" },
            { type: "file", url: pdfUrl, filename: "guide.pdf", mime: "text/plain" },
          ],
        })

        expect(msg.parts.some((part) => part.type === "file" && part.mime === "application/pdf")).toBe(false)
        expect(msg.parts.some((part) => part.type === "file" && part.url === pdfUrl)).toBe(true)
      }),
    { git: true, config: cfg },
  ),
)

it.live("tells the model when image content cannot be provided to it", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const png = path.join(dir, "shot.png")
        const pngUrl = pathToFileURL(png).href
        yield* Effect.promise(() => Bun.write(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))

        const msg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "what is in this image?" },
            { type: "file", url: pngUrl, filename: "shot.png", mime: "text/plain" },
          ],
        })

        expect(msg.parts.some((part) => part.type === "file" && part.mime === "image/png")).toBe(false)
        const texts = msg.parts.filter((part) => part.type === "text").map((part) => part.text)
        // A capability-dropped attachment must not leave the model believing
        // the read succeeded — that produces confident hallucination.
        expect(texts.some((text) => text.includes("Image read successfully"))).toBe(false)
        expect(texts.some((text) => /NOT provided/.test(text))).toBe(true)
      }),
    { git: true, config: cfg },
  ),
)

it.live("text file part promotes PDF attachment when model has image input", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const pdf = path.join(dir, "guide.pdf")
        const pdfUrl = pathToFileURL(pdf).href
        yield* Effect.promise(() => Bun.write(pdf, "%PDF-1.7\n"))

        const msg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "read this PDF" },
            { type: "file", url: pdfUrl, filename: "guide.pdf", mime: "text/plain" },
          ],
        })

        expect(msg.parts.some((part) => part.type === "file" && part.mime === "application/pdf")).toBe(true)
      }),
    { git: true, config: imageCfg },
  ),
)

it.live("image upgrade replaces the submitted file part in place", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const png = path.join(dir, "shot.png")
        const pngUrl = pathToFileURL(png).href
        yield* Effect.promise(() => Bun.write(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))

        const submittedID = PartID.ascending()
        const msg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "what is in this image?" },
            {
              type: "file",
              id: submittedID,
              url: pngUrl,
              filename: "shot.png",
              mime: "text/plain",
              metadata: { attachment: true },
            },
          ],
        })

        const fileParts = msg.parts.filter((part): part is MessageV2.FilePart => part.type === "file")
        // The upgraded media part must keep the submitted part id. Id-keyed
        // consumers (the client's optimistic part merge) otherwise treat it as
        // a second attachment and render two chips for one file.
        expect(fileParts).toHaveLength(1)
        expect(fileParts[0].id).toBe(submittedID)
        expect(fileParts[0].mime).toBe("image/png")
        expect(fileParts[0].metadata?.attachment).toBe(true)
      }),
    { git: true, config: imageCfg },
  ),
)

it.live("loop continues when finish is stop but assistant has tool parts", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.push(reply().tool("first", { value: "first" }).stop())
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("failed subtask preserves metadata on error tool state", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.tool("agent", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.text("done")
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      expect(yield* llm.calls).toBe(2)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = errorTool(taskMsg.parts)
      if (!tool) return

      expect(tool.state.error).toContain("Tool execution failed")
      expect(tool.state.metadata).toBeDefined()
      expect(tool.state.metadata?.sessionId).toBeDefined()
      expect(tool.state.metadata?.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("missing-model"),
      })
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: {
          general: {
            model: "test/missing-model",
          },
        },
      }),
    },
  ),
)

it.live(
  "running subtask preserves metadata after tool-call transition",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        const msg = yield* user(chat.id, "hello")
        yield* addSubtask(chat.id, msg.id)

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

        const tool = yield* Effect.promise(async () => {
          const end = Date.now() + 5_000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(MessageV2.filterCompactedEffect(chat.id))
            const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
            const tool = taskMsg?.parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
            if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for running subtask metadata")
        })

        if (tool.state.status !== "running") return
        expect(typeof tool.state.metadata?.sessionId).toBe("string")
        expect(tool.state.title).toBeDefined()
        expect(tool.state.metadata?.model).toBeDefined()

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  5_000,
)

it.live(
  "running agent tool preserves metadata after tool-call transition",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.tool("agent", {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

        const tool = yield* Effect.promise(async () => {
          const end = Date.now() + 5_000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(MessageV2.filterCompactedEffect(chat.id))
            const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
            const tool = assistant?.parts.find(
              (part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "agent",
            )
            if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for running agent metadata")
        })

        if (tool.state.status !== "running") return
        expect(typeof tool.state.metadata?.sessionId).toBe("string")
        expect(tool.state.title).toBe("inspect bug")
        expect(tool.state.metadata?.model).toBeDefined()

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "loop sets status to busy then idle",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        expect((yield* status.get(chat.id)).type).toBe("busy")
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
        expect((yield* status.get(chat.id)).type).toBe("idle")
      }),
      { git: true, config: providerCfg },
    ),
)

// Cancel semantics

it.live(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* seed(chat.id)

        yield* llm.hang

        yield* user(chat.id, "more")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
        }
      }),
      { git: true, config: providerCfg },
    ),
)

it.live(
  "cancel records MessageAbortedError on interrupted process",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          const info = exit.value.info
          if (info.role === "assistant") {
            expect(info.error?.name).toBe("MessageAbortedError")
          }
        }
      }),
      { git: true, config: providerCfg },
    ),
)

it.live(
  "cancel before current assistant scaffold does not attach abort diagnostics to the previous assistant",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const { prompt, sessions, chat } = yield* boot({ title: "Pinned" })
        const seeded = yield* seed(chat.id)
        const nextUser = yield* user(chat.id, "more")

        const started = defer<void>()
        const release = defer<void>()
        const mutableSessions = sessions as Mutable<typeof sessions>
        const originalUpdateMessage = sessions.updateMessage
        mutableSessions.updateMessage = (info) => {
          if (info.role === "assistant" && info.parentID === nextUser.id) {
            return Effect.gen(function* () {
              started.resolve()
              yield* Effect.promise(() => release.promise)
              return yield* originalUpdateMessage(info)
            })
          }
          return originalUpdateMessage(info)
        }
        yield* Effect.addFinalizer(() => Effect.sync(() => void (mutableSessions.updateMessage = originalUpdateMessage)))

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.promise(() => started.promise)
        yield* prompt.cancel(chat.id)
        release.resolve()
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)

        const previous = yield* sessions.findMessage(chat.id, (message) => message.info.id === seeded.assistant.id)
        expect(Option.isSome(previous)).toBe(true)
        if (Option.isSome(previous) && previous.value.info.role === "assistant") {
          expect(previous.value.info.diagnostics?.abort).toBeUndefined()
        }
      }),
      { git: true, config: providerCfg },
    ),
)

it.live(
  "cancel after assistant scaffold save finalizes before processor handle",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Processor creation cancel" })
        const currentUser = yield* user(chat.id, "hello")

        const started = defer<void>()
        const mutableSessions = sessions as Mutable<typeof sessions>
        const originalUpdateMessage = sessions.updateMessage
        let blockedAssistantScaffold = false
        mutableSessions.updateMessage = (info) => {
          if (!blockedAssistantScaffold && info.role === "assistant" && info.parentID === currentUser.id) {
            blockedAssistantScaffold = true
            return Effect.gen(function* () {
              const saved = yield* originalUpdateMessage(info)
              started.resolve()
              yield* Effect.never
              return saved
            })
          }
          return originalUpdateMessage(info)
        }
        yield* Effect.addFinalizer(() => Effect.sync(() => void (mutableSessions.updateMessage = originalUpdateMessage)))

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        const startedExit = yield* Effect.promise(() => started.promise).pipe(
          Effect.timeout(cancelRaceCheckpointTimeout),
          Effect.exit,
        )
        expect(Exit.isSuccess(startedExit)).toBe(true)
        const cancelExit = yield* prompt.cancel(chat.id).pipe(Effect.timeout(cancelRaceCheckpointTimeout), Effect.exit)
        expect(Exit.isSuccess(cancelExit)).toBe(true)
        const exit = yield* Fiber.await(fiber).pipe(Effect.timeout(cancelRaceCheckpointTimeout))
        expect(Exit.isSuccess(exit)).toBe(true)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const assistant = messages.find(
          (message) => message.info.role === "assistant" && message.info.parentID === currentUser.id,
        )
        expect(assistant?.info.role).toBe("assistant")
        if (!assistant || assistant.info.role !== "assistant") return
        expect(assistant.parts).toHaveLength(0)
        expect(assistant.info.error?.name).toBe("MessageAbortedError")
        expect(assistant.info.time.completed).toBeNumber()
        expect(assistant.info.diagnostics?.abort).toMatchObject({
          source: "session.prompt.cancel",
          reason: "cancel",
          propagation_point: "session.prompt.loop.onInterrupt",
          error_name: "MessageAbortedError",
        })
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "cancel after processor handle creation finalizes before process starts",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const plugin = yield* Plugin.Service
        const chat = yield* sessions.create({ title: "Pre-process cancel" })
        const currentUser = yield* user(chat.id, "hello")

        const started = defer<void>()
        const mutablePlugin = plugin as Mutable<typeof plugin>
        const originalTrigger = plugin.trigger
        mutablePlugin.trigger = ((name: Parameters<typeof plugin.trigger>[0], input: unknown, output: unknown) => {
          if (name === "experimental.chat.messages.transform") {
            return Effect.gen(function* () {
              started.resolve()
              return yield* Effect.never
            })
          }
          return originalTrigger(name as never, input as never, output as never)
        }) as typeof plugin.trigger
        yield* Effect.addFinalizer(() => Effect.sync(() => void (mutablePlugin.trigger = originalTrigger)))

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        const startedExit = yield* Effect.promise(() => started.promise).pipe(
          Effect.timeout(cancelRaceCheckpointTimeout),
          Effect.exit,
        )
        expect(Exit.isSuccess(startedExit)).toBe(true)
        const cancelExit = yield* prompt.cancel(chat.id).pipe(Effect.timeout(cancelRaceCheckpointTimeout), Effect.exit)
        expect(Exit.isSuccess(cancelExit)).toBe(true)
        const exit = yield* Fiber.await(fiber).pipe(Effect.timeout(cancelRaceCheckpointTimeout))
        expect(Exit.isSuccess(exit)).toBe(true)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const assistant = messages.find(
          (message) => message.info.role === "assistant" && message.info.parentID === currentUser.id,
        )
        expect(assistant?.info.role).toBe("assistant")
        if (!assistant || assistant.info.role !== "assistant") return
        expect(assistant.parts).toHaveLength(0)
        expect(assistant.info.error?.name).toBe("MessageAbortedError")
        expect(assistant.info.time.completed).toBeNumber()
        expect(assistant.info.diagnostics?.abort).toMatchObject({
          source: "session.prompt.cancel",
          reason: "cancel",
          propagation_point: "session.prompt.loop.onInterrupt",
          error_name: "MessageAbortedError",
        })
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "cancel interrupts the running loop",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Cancel" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        const cancelled = yield* prompt.cancel(chat.id)
        expect(cancelled).toBe(true)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit) && exit.value.info.role === "assistant") {
          expect(exit.value.info.error?.name).toBe("MessageAbortedError")
          expect(exit.value.info.diagnostics?.abort).toMatchObject({
            source: "session.prompt.cancel",
            reason: "cancel",
            propagation_point: "session.prompt.loop.onInterrupt",
            error_name: "MessageAbortedError",
            via_ctx_abort: false,
          })
        }
      }),
      { git: true, config: providerCfg },
    ),
)

it.live(
  "cancel during compaction prelude interrupts the run",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Compaction prelude cancel" })
        yield* seed(chat.id, { finish: "stop" })
        yield* llm.hang

        // The prelude runs inside the Runner's fiber, so cancel below would
        // be silently dropped by SessionRunState.cancel (no-runner path) if
        // it ran outside ensureRunning's protection. Reaching llm.wait(1)
        // proves the prelude wrote the marker, runLoop entered, and the
        // runner is in Running state — exactly the window the pre-refactor
        // route exposed when status was set busy before the runner existed.
        const fiber = yield* prompt
          .loop({
            sessionID: chat.id,
            prelude: {
              type: "compaction",
              agent: "build",
              model: ref,
              auto: false,
            },
          })
          .pipe(Effect.forkChild)
        yield* llm.wait(1)
        const cancelled = yield* prompt.cancel(chat.id)
        expect(cancelled).toBe(true)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)

        const msgs = yield* sessions.messages({ sessionID: chat.id })
        expect(msgs.some((m) => m.parts.some((p) => p.type === "compaction"))).toBe(true)
        const summary = msgs.find((m) => m.info.role === "assistant" && m.info.summary === true)
        expect(summary).toBeDefined()
        if (summary?.info.role === "assistant") {
          expect(summary.info.error?.name).toBe("MessageAbortedError")
        }
      }),
      { git: true, config: providerCfg },
    ),
)

it.live(
  "cancel after compaction marker but before placeholder yields aborted carrier",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Compaction prelude race cancel" })
        yield* seed(chat.id, { finish: "stop" })
        yield* llm.hang

        const fiber = yield* prompt
          .loop({
            sessionID: chat.id,
            prelude: { type: "compaction", agent: "build", model: ref, auto: false },
          })
          .pipe(Effect.forkChild)

        // Polling targets the precise race window: marker present, summary
        // placeholder not yet written. Breaking only on that combined state
        // (rather than the marker alone) guarantees the cancel lands inside
        // the window the new onInterrupt fallback was added to cover.
        // observedRaceWindow distinguishes "loop hit the window then broke"
        // from "deadline expired" — a setup failure (placeholder beat
        // polling) fails explicitly here instead of producing a confusing
        // propagation_point mismatch downstream.
        const deadline = Date.now() + 5000
        let observedRaceWindow = false
        while (Date.now() < deadline) {
          const snapshot = yield* sessions.messages({ sessionID: chat.id })
          const hasMarker = snapshot.some((m) => m.parts.some((p) => p.type === "compaction"))
          const hasPlaceholder = snapshot.some((m) => m.info.role === "assistant" && m.info.summary === true)
          if (hasMarker && !hasPlaceholder) {
            observedRaceWindow = true
            break
          }
          yield* Effect.sleep("1 millis")
        }
        expect(observedRaceWindow).toBe(true)

        const cancelled = yield* prompt.cancel(chat.id)
        expect(cancelled).toBe(true)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)

        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const marker = msgs.find((m) => m.parts.some((p) => p.type === "compaction"))
        expect(marker).toBeDefined()
        const summary = msgs.find((m) => m.info.role === "assistant" && m.info.summary === true)
        expect(summary).toBeDefined()
        if (summary?.info.role === "assistant" && marker) {
          expect(summary.info.error?.name).toBe("MessageAbortedError")
          expect(summary.info.finish).toBe("error")
          expect(typeof summary.info.time.completed).toBe("number")
          expect(summary.info.parentID).toBe(marker.info.id)
          // Locks the new onInterrupt fallback branch — if the test ever
          // misses the race window and the existing processCompaction
          // finalizer handles the cancel, propagation_point would differ.
          expect(summary.info.diagnostics?.abort?.propagation_point).toBe(
            "session.prompt.loop.onInterrupt.compaction_prelude",
          )
        }
      }),
      { git: true, config: providerCfg },
    ),
)

it.live(
  "cancel after a queued user message still resolves the orphaned compaction marker",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Compaction queued-prompt race cancel" })
        yield* seed(chat.id, { finish: "stop" })
        yield* llm.hang

        const fiber = yield* prompt
          .loop({
            sessionID: chat.id,
            prelude: { type: "compaction", agent: "build", model: ref, auto: false },
          })
          .pipe(Effect.forkChild)

        const deadline = Date.now() + 5000
        let observedRaceWindow = false
        while (Date.now() < deadline) {
          const snapshot = yield* sessions.messages({ sessionID: chat.id })
          const hasMarker = snapshot.some((m) => m.parts.some((p) => p.type === "compaction"))
          const hasPlaceholder = snapshot.some((m) => m.info.role === "assistant" && m.info.summary === true)
          if (hasMarker && !hasPlaceholder) {
            observedRaceWindow = true
            break
          }
          yield* Effect.sleep("1 millis")
        }
        expect(observedRaceWindow).toBe(true)

        // Inject a queued user message ahead of the cancel — mirrors what
        // SessionPrompt.prompt does when it lands while compaction is
        // running: createUserMessage persists the new user before
        // ensureRunning awaitRuns the existing run. After this,
        // currentTurnTarget returns the queued user instead of the
        // marker, so the older "current turn is marker" gate would skip
        // the carrier write and leave the marker as an orphan rendering
        // `failed`. The sweep must find the marker regardless.
        const queuedUser = yield* user(chat.id, "queued prompt")

        const cancelled = yield* prompt.cancel(chat.id)
        expect(cancelled).toBe(true)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)

        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const marker = msgs.find((m) => m.parts.some((p) => p.type === "compaction"))
        expect(marker).toBeDefined()
        expect(queuedUser.id).not.toBe(marker?.info.id)
        const summary = msgs.find(
          (m) =>
            m.info.role === "assistant" &&
            m.info.summary === true &&
            m.info.parentID === marker?.info.id,
        )
        expect(summary).toBeDefined()
        if (summary?.info.role === "assistant" && marker) {
          expect(summary.info.error?.name).toBe("MessageAbortedError")
          expect(summary.info.finish).toBe("error")
          expect(typeof summary.info.time.completed).toBe("number")
          expect(summary.info.diagnostics?.abort?.propagation_point).toBe(
            "session.prompt.loop.onInterrupt.compaction_prelude",
          )
        }
      }),
      { git: true, config: providerCfg },
    ),
)

it.live(
  "prelude derives compaction agent from the post-cleanup latest user",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Prelude agent derivation" })

        // userOne uses the default "build" agent — this is the agent
        // /summarize must pick after revert.cleanup drops everything
        // newer than userOne.
        const userOne = yield* user(chat.id, "first")

        // userTwo is written directly with a different agent. revert
        // points back to userOne, so cleanup removes userTwo before
        // the prelude derives its agent. Pre-cleanup derivation (the
        // regression this test locks against) would have picked
        // "ninja" off the still-present userTwo.
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "ninja",
          model: ref,
          time: { created: Date.now() },
        })

        yield* sessions.setRevert({
          sessionID: chat.id,
          revert: { messageID: userOne.id },
          summary: { additions: 0, deletions: 0, files: 0 },
        })

        yield* llm.hang

        const fiber = yield* prompt
          .loop({
            sessionID: chat.id,
            prelude: { type: "compaction", model: ref, auto: false },
          })
          .pipe(Effect.forkChild)

        // Poll until the marker is written, then cancel — only the
        // marker's agent matters for this assertion; the rest of the
        // run can abort.
        const deadline = Date.now() + 5000
        let marker: MessageV2.WithParts | undefined
        while (Date.now() < deadline) {
          const snapshot = yield* sessions.messages({ sessionID: chat.id })
          marker = snapshot.find((m) => m.parts.some((p) => p.type === "compaction"))
          if (marker) break
          yield* Effect.sleep("1 millis")
        }
        expect(marker).toBeDefined()

        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)

        // After revert.cleanup, userTwo ("ninja") is gone; userOne
        // ("build") is the latest remaining user, so the marker must
        // record "build".
        if (marker?.info.role === "user") {
          expect(marker.info.agent).toBe("build")
        }
      }),
      { git: true, config: providerCfg },
    ),
)

it.live(
  "loop rejects compaction prelude when a run is already in flight",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Compaction prelude busy" })
        yield* llm.hang
        yield* user(chat.id, "hi")

        // Hold a normal prompt run in Running so ensureRunning sees a non-Idle
        // state when the prelude call arrives. Pre-fix, the second call would
        // awaitRun(existing) and silently resolve `true` without writing the
        // marker — this asserts rejectIfBusy fires instead.
        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const before = yield* sessions.messages({ sessionID: chat.id })
        const compactionBefore = before.filter((m) => m.parts.some((p) => p.type === "compaction")).length

        const exit = yield* prompt
          .loop({
            sessionID: chat.id,
            prelude: { type: "compaction", agent: "build", model: ref, auto: false },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        const after = yield* sessions.messages({ sessionID: chat.id })
        const compactionAfter = after.filter((m) => m.parts.some((p) => p.type === "compaction")).length
        expect(compactionAfter).toBe(compactionBefore)

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
)

it.live(
  "cancel preserves explicit caller source in abort diagnostics",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Caller source" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        const cancelled = yield* prompt.cancel(chat.id, { source: "renderer.emptyEnter" })
        expect(cancelled).toBe(true)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit) && exit.value.info.role === "assistant") {
          expect(exit.value.info.diagnostics?.abort).toMatchObject({
            source: "renderer.emptyEnter",
            reason: "cancel",
            propagation_point: "session.prompt.loop.onInterrupt",
          })
        }
      }),
      { git: true, config: providerCfg },
    ),
)

it.live(
  "cancel finalizes subtask tool state",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const ready = defer<void>()
          const aborted = defer<void>()
          const registry = yield* ToolRegistry.Service
          const { agent } = yield* registry.named()
          const original = agent.execute
          agent.execute = (_args, ctx) =>
            Effect.callback<never>((_resume) => {
              ready.resolve()
              ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
              return Effect.sync(() => aborted.resolve())
            })
          yield* Effect.addFinalizer(() => Effect.sync(() => void (agent.execute = original)))

          const { prompt, chat } = yield* boot()
          const msg = yield* user(chat.id, "hello")
          yield* addSubtask(chat.id, msg.id)

          const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.promise(() => ready.promise)
          yield* prompt.cancel(chat.id)
          yield* Effect.promise(() => aborted.promise)

          const exit = yield* Fiber.await(fiber)
          expect(Exit.isSuccess(exit)).toBe(true)

          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          expect(taskMsg?.info.role).toBe("assistant")
          if (!taskMsg || taskMsg.info.role !== "assistant") return

          const tool = toolPart(taskMsg.parts)
          expect(tool?.type).toBe("tool")
          if (!tool) return

          expect(tool.state.status).not.toBe("running")
          expect(taskMsg.info.time.completed).toBeDefined()
          expect(taskMsg.info.finish).toBeDefined()
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.live(
  "cancel with queued callers resolves all cleanly",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        yield* prompt.cancel(chat.id)
        const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(exitA)).toBe(true)
        expect(Exit.isSuccess(exitB)).toBe(true)
        if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
          expect(exitA.value.info.id).toBe(exitB.value.info.id)
        }
      }),
      { git: true, config: providerCfg },
    ),
)

// Queue semantics

it.live("concurrent loop callers get same result", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        yield* seed(chat.id, { finish: "stop" })

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })

        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true },
  ),
)

it.live(
  "concurrent loop callers all receive same error result",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.fail("boom")
        yield* user(chat.id, "hello")

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })
        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
      }),
      { git: true, config: providerCfg },
    ),
)

it.live(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.hold("first", gate.promise)
        yield* llm.text("second")

        const a = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)

        const id = MessageID.ascending()
        const b = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "second" }],
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            if (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id)) return
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for second prompt to save")
        })

        gate.resolve()

        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        expect(yield* llm.calls).toBe(2)

        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const assistants = msgs.filter((msg) => msg.info.role === "assistant")
        expect(assistants).toHaveLength(2)
        const last = assistants.at(-1)
        if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
        expect(last.info.parentID).toBe(id)
        expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(2)
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("second")
      }),
      { git: true, config: providerCfg },
    ),
)

it.live(
  "assertNotBusy throws BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service
        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
)

it.live("assertNotBusy succeeds when idle", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service

        const chat = yield* sessions.create({})
        const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    { git: true },
  ),
)

// Shell semantics

it.live(
  "shell rejects with BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
)

unix("shell captures stdout and stderr in completed tool output", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "printf out && printf err >&2",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("out")
        expect(tool.state.output).toContain("err")
        expect(tool.state.metadata.output).toContain("out")
        expect(tool.state.metadata.output).toContain("err")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell does not expose internal server auth env", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const previousUsername = process.env.OPENCODE_SERVER_USERNAME
        const previousPassword = process.env.OPENCODE_SERVER_PASSWORD
        const previousCustom = process.env.PAWWORK_E2E_CUSTOM_ENV
        process.env.OPENCODE_SERVER_USERNAME = "PawWork"
        process.env.OPENCODE_SERVER_PASSWORD = "secret"
        process.env.PAWWORK_E2E_CUSTOM_ENV = "kept"

        try {
          const { prompt, chat } = yield* boot()
          const result = yield* prompt.shell({
            sessionID: chat.id,
            agent: "build",
            command:
              'printf "username=%s\\n" "${OPENCODE_SERVER_USERNAME-unset}" && printf "password=%s\\n" "${OPENCODE_SERVER_PASSWORD-unset}" && printf "custom=%s\\n" "${PAWWORK_E2E_CUSTOM_ENV-unset}"',
          })
          const tool = completedTool(result.parts)
          if (!tool) return

          expect(tool.state.output).toContain("username=unset")
          expect(tool.state.output).toContain("password=unset")
          expect(tool.state.output).toContain("custom=kept")
          expect(tool.state.output).not.toContain("secret")
        } finally {
          if (previousUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME
          else process.env.OPENCODE_SERVER_USERNAME = previousUsername
          if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
          else process.env.OPENCODE_SERVER_PASSWORD = previousPassword
          if (previousCustom === undefined) delete process.env.PAWWORK_E2E_CUSTOM_ENV
          else process.env.PAWWORK_E2E_CUSTOM_ENV = previousCustom
        }
      }),
    { git: true, config: cfg },
  ),
)

unix("shell completes a fast command on the preferred shell", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("pwd")
        expect(tool.state.output).toContain(dir)
        expect(tool.state.metadata.output).toContain(dir)
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell uses the session execution context directory", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, sessions, chat } = yield* boot()
        const activeDir = path.join(dir, ".worktrees", "pawwork", "shell-context")
        yield* Effect.promise(() => fs.mkdir(activeDir, { recursive: true }))
        yield* sessions.updateExecutionContext({
          sessionID: chat.id,
          activeWorktree: {
            directory: activeDir,
            name: "shell-context",
            branch: "pawwork/shell-context",
            source: "created",
          },
        })

        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "pwd",
        })
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(activeDir)
      }),
    { git: true, config: cfg },
  ),
)

unix("bash tool uses the session execution context directory", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Tool cwd",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const activeDir = path.join(dir, ".worktrees", "pawwork", "tool-context")
        yield* Effect.promise(() => fs.mkdir(activeDir, { recursive: true }))
        yield* sessions.updateExecutionContext({
          sessionID: chat.id,
          activeWorktree: {
            directory: activeDir,
            name: "tool-context",
            branch: "pawwork/tool-context",
            source: "created",
          },
        })

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "print cwd" }],
        })
        yield* llm.tool("bash", {
          command: "pwd",
          description: "Print cwd",
        })
        yield* llm.text("done")
        const result = yield* prompt.loop({ sessionID: chat.id })
        expect(result.info.role).toBe("assistant")

        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        const tool = msgs
          .flatMap((msg) => msg.parts)
          .find(
            (part): part is CompletedToolPart =>
              part.type === "tool" && part.tool === "bash" && part.state.status === "completed",
          )
        if (!tool) throw new Error("Missing completed bash tool part")

        expect(tool.state.output).toContain(activeDir)
      }),
    { git: true, config: providerCfg },
  ),
)

unix("shell commands can change directory after login startup", () =>
  withShell("/bin/bash", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { prompt, run, chat } = yield* boot()
          const parent = path.dirname(dir)
          const result = yield* prompt.shell({
            sessionID: chat.id,
            agent: "build",
            command: 'printf "argc:%s\\n" "$#"; cd .. && pwd',
          })

          expect(result.info.role).toBe("assistant")
          const tool = completedTool(result.parts)
          if (!tool) return

          expect(tool.state.output).toContain("argc:0")
          expect(tool.state.output).toContain(parent)
          expect(tool.state.metadata.output).toContain("argc:0")
          expect(tool.state.metadata.output).toContain(parent)
          yield* run.assertNotBusy(chat.id)
        }),
      { git: true, config: cfg },
    ),
  ),
)

unix("shell lists files from the project directory", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        yield* Effect.promise(() => Bun.write(path.join(dir, "README.md"), "# e2e\n"))

        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "command ls",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("command ls")
        expect(tool.state.output).toContain("README.md")
        expect(tool.state.metadata.output).toContain("README.md")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell captures stderr from a failing command", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("not found")
        expect(tool.state.metadata.output).toContain("not found")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const fiber = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
              .pipe(Effect.forkChild)

            yield* Effect.promise(async () => {
              const start = Date.now()
              while (Date.now() - start < 5000) {
                const msgs = await MessageV2.filterCompacted(MessageV2.stream(chat.id))
                const taskMsg = msgs.find((item) => item.info.role === "assistant")
                const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
                if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return
                await new Promise((done) => setTimeout(done, 20))
              }
              throw new Error("timed out waiting for running shell metadata")
            })

            const exit = yield* Fiber.await(fiber)
            expect(Exit.isSuccess(exit)).toBe(true)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "loop waits while shell runs and starts after shell exits",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("after-shell")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const exit = yield* Fiber.await(loop)

        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
)

unix(
  "shell completion resumes queued loop callers",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("done")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
          expect(ea.value.info.id).toBe(eb.value.info.id)
          expect(ea.value.info.role).toBe("assistant")
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
)

unix(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, run, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const status = yield* SessionStatus.Service
            expect((yield* status.get(chat.id)).type).toBe("idle")
            const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
            expect(Exit.isSuccess(busy)).toBe(true)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "trap '' TERM; sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: "Interrupted bash truncation",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "run bash" }],
          })

          yield* llm.tool("bash", {
            command:
              'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; sleep 30',
            description: "Print many lines",
            timeout: 30_000,
            workdir: path.resolve(dir),
          })

          const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* llm.wait(1)
          yield* Effect.sleep(150)
          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(run)
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isFailure(exit)) return

          const tool = completedTool(exit.value.parts)
          if (!tool) return

          expect(tool.state.metadata.truncated).toBe(true)
          expect(typeof tool.state.metadata.outputPath).toBe("string")
          expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
          expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
          expect(tool.state.output).not.toContain("Tool execution aborted")
        }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

unix(
  "cancel interrupts loop queued behind shell",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const { prompt, chat } = yield* boot()

          const sh = yield* prompt
            .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
            .pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(loop)
          expect(Exit.isSuccess(exit)).toBe(true)

          yield* Fiber.await(sh)
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

unix(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const a = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            const exit = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "echo hi" })
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
            }

            yield* prompt.cancel(chat.id)
            yield* Fiber.await(a)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

// Abort signal propagation tests for inline tool execution

/** Override a tool's execute to hang until aborted. Returns ready/aborted defers and a finalizer. */
function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  const ready = defer<void>()
  const aborted = defer<void>()
  const original = tool.execute
  tool.execute = (_args: any, ctx: any) => {
    ready.resolve()
    ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
    return Effect.callback<never>(() => {})
  }
  const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
  return { ready, aborted, restore }
}

it.live(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const { read } = yield* registry.named()
          const { ready, aborted, restore } = hangUntilAborted(read)
          yield* restore

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Abort Test" })

          const testFile = path.join(dir, "test.txt")
          yield* Effect.promise(() => Bun.write(testFile, "hello world"))

          const fiber = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "build",
              parts: [
                { type: "text", text: "read this" },
                { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => ready.promise)
          yield* Fiber.interrupt(fiber)

          yield* Effect.promise(() =>
            Promise.race([
              aborted.promise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("abort signal not propagated within 2s")), 2_000),
              ),
            ]),
          )
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.live(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const { read } = yield* registry.named()
          const { ready, aborted, restore } = hangUntilAborted(read)
          yield* restore

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Abort Test" })

          const fiber = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "build",
              parts: [
                { type: "text", text: "read this" },
                { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => ready.promise)
          yield* Fiber.interrupt(fiber)

          yield* Effect.promise(() =>
            Promise.race([
              aborted.promise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("abort signal not propagated within 2s")), 2_000),
              ),
            ]),
          )
        }),
      { git: true, config: cfg },
    ),
  30_000,
)
