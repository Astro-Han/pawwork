import { NodeFileSystem } from "@effect/platform-node"
import { tool } from "ai"
import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider"
import * as ProviderTransform from "../../src/provider/transform"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionDiagnostics } from "../../src/session/diagnostics"
import { beginLifecycleClose, closingStartWaiterCount, createLifecycleCloseAction, withLifecycleCloseAction } from "../../src/session/lifecycle-provenance"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { TurnChange } from "../../src/session/turn-change"
import { Snapshot } from "../../src/snapshot"
import { Log } from "../../src/util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

const FAST_SAFE_RECOVERY_DELAY = () => 10

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

const reasoningRef = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("reasoning-model"),
}

const copilotResponsesRef = {
  providerID: ProviderID.make("github-copilot"),
  modelID: ModelID.make("gpt-5.2"),
}

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
        "reasoning-model": {
          id: "reasoning-model",
          name: "Reasoning Model",
          attachment: false,
          reasoning: true,
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

function providerCfgWithDisabledAutoCompaction(url: string) {
  return {
    ...providerCfg(url),
    compaction: {
      auto: false,
    },
  }
}

function copilotResponsesProviderCfg(url: string) {
  return {
    provider: {
      "github-copilot": {
        name: "GitHub Copilot",
        id: "github-copilot",
        env: ["GITHUB_COPILOT_TOKEN"],
        npm: "@ai-sdk/github-copilot",
        api: "https://api.githubcopilot.com/v1",
        models: {
          "gpt-5.2": {
            id: "gpt-5.2",
            name: "GPT 5.2",
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
          apiKey: "test-copilot-key",
          baseURL: url,
        },
      },
    },
  }
}

function responseCreated(model = "gpt-5.2") {
  return {
    type: "response.created",
    sequence_number: 1,
    response: { id: "resp_test", created_at: 1779358949, model, service_tier: null },
  }
}

function responseFunctionCallAdded() {
  return {
    type: "response.output_item.added",
    sequence_number: 2,
    output_index: 0,
    item: {
      type: "function_call",
      id: "fc_1",
      call_id: "call_responses_args_done_only",
      name: "noop",
      arguments: "",
      status: "in_progress",
    },
  }
}

function responseFunctionCallArgumentsDone() {
  return {
    type: "response.function_call_arguments.done",
    sequence_number: 3,
    output_index: 0,
    item_id: "fc_1",
    name: "noop",
    arguments: "{}",
  }
}

function responseCompleted() {
  return {
    type: "response.completed",
    sequence_number: 4,
    response: {
      incomplete_details: null,
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: null },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: null },
      },
      service_tier: null,
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

type TestDeferred<T> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

function defer<T>(): TestDeferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
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
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const depsWithoutLLM = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  Provider.defaultLayer,
  TurnChange.defaultLayer,
  status,
).pipe(Layer.provideMerge(infra))
const deps = Layer.mergeAll(depsWithoutLLM, LLM.defaultLayer)
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

function processorEnvWithLLM(llm: LLM.Interface) {
  const testLLM = Layer.succeed(LLM.Service, LLM.Service.of(llm))
  const testDeps = Layer.mergeAll(depsWithoutLLM, testLLM)
  return Layer.mergeAll(
    testDeps,
    SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(testDeps)),
  )
}

const capturedAttemptConnectTimeouts: number[] = []
const attemptTimeoutIt = testEffect(
  processorEnvWithLLM({
    stream(input) {
      const connectTimeoutMs = input.connectTimeoutMs ?? LLM.CONNECT_STREAM_TIMEOUT_MS
      const streamTimeoutMs = input.streamTimeoutMs ?? LLM.SILENT_STREAM_TIMEOUT_MS
      const error = new Error(`LLM stream connection timed out after ${connectTimeoutMs}ms without provider progress`)
      capturedAttemptConnectTimeouts.push(connectTimeoutMs)
      input.trace?.beginStream({
        collectorCreatedAt: Date.now(),
        monotonicMs: performance.now(),
        connectTimeoutMs,
        streamTimeoutMs,
      })
      input.trace?.recordWatchdogFired({
        phase: "connect",
        firedAt: Date.now(),
        monotonicMs: performance.now(),
      })
      input.trace?.recordStreamFailure({
        error,
        boundary: "watchdog",
        confidence: "high",
        evidence: ["watchdog_fired", "watchdog_error"],
        failedAt: Date.now(),
        monotonicMs: performance.now(),
      })
      return Stream.fail(error)
    },
  }),
)

const lifecycleBeforeToolEventFailures: unknown[] = []
const lifecycleBeforeToolEventIt = testEffect(
  processorEnvWithLLM({
    stream(input) {
      const toolCallID = "call_lifecycle_before_event"
      const toolInput = { value: "ok" }
      return Stream.fromEffect(
        Effect.promise(async () => {
          await input.toolLifecycle?.started?.({ tool: "fast", toolCallID, input: toolInput })
          void Promise.resolve(
            input.toolLifecycle?.completed?.({
              toolCallID,
              output: {
                title: "fast",
                metadata: { marker: "lifecycle-first" },
                output: "fast result",
              },
            }),
          ).catch((error) => {
            lifecycleBeforeToolEventFailures.push(error)
          })
        }),
      ).pipe(
        Stream.flatMap(() =>
          Stream.make(
            { type: "start" } satisfies LLM.Event,
            {
              type: "tool-input-start",
              id: toolCallID,
              toolName: "fast",
            } as LLM.Event,
            {
              type: "tool-call",
              toolCallId: toolCallID,
              toolName: "fast",
              input: toolInput,
              providerMetadata: undefined,
            } as LLM.Event,
          ),
        ),
      )
    },
  }),
)

const noStreamToolCompletionFailures: unknown[] = []
const noStreamToolCompletionIt = testEffect(
  processorEnvWithLLM({
    stream(input) {
      const toolCallID = "call_no_stream_tool_completion"
      const toolInput = { value: "ok" }
      return Stream.fromEffect(
        Effect.promise(async () => {
          await input.toolLifecycle?.started?.({ tool: "offline", toolCallID, input: toolInput })
          void Promise.resolve(
            input.toolLifecycle?.completed?.({
              toolCallID,
              output: {
                title: "offline",
                metadata: { marker: "no-stream" },
                output: "offline result",
              },
            }),
          ).catch((error) => {
            noStreamToolCompletionFailures.push(error)
          })
        }),
      ).pipe(Stream.flatMap(() => Stream.fail(new Error("connection reset before tool events"))))
    },
  }),
)

const noStreamToolFailureFailures: unknown[] = []
const noStreamToolFailureIt = testEffect(
  processorEnvWithLLM({
    stream(input) {
      const toolCallID = "call_no_stream_tool_failure"
      const toolInput = { value: "bad" }
      return Stream.fromEffect(
        Effect.promise(async () => {
          await input.toolLifecycle?.started?.({ tool: "offline", toolCallID, input: toolInput })
          void Promise.resolve(input.toolLifecycle?.failed?.({ toolCallID, error: new Error("offline failure") })).catch(
            (error) => {
              noStreamToolFailureFailures.push(error)
            },
          )
        }),
      ).pipe(Stream.flatMap(() => Stream.fail(new Error("connection reset before tool error event"))))
    },
  }),
)

const noStreamDeadToolIt = testEffect(
  processorEnvWithLLM({
    stream(input) {
      const toolCallID = "call_no_stream_dead_tool"
      const toolInput = { value: "stuck" }
      return Stream.fromEffect(
        Effect.promise(async () => {
          await input.toolLifecycle?.started?.({ tool: "offline", toolCallID, input: toolInput })
        }),
      ).pipe(Stream.flatMap(() => Stream.fail(new Error("connection reset before dead tool events"))))
    },
  }),
)

type CapturedToolLifecycle = NonNullable<LLM.StreamInput["toolLifecycle"]>
const lateLifecycleAfterFinalizeState: {
  lifecycle?: CapturedToolLifecycle
} = {}
const lateLifecycleAfterFinalizeIt = testEffect(
  processorEnvWithLLM({
    stream(input) {
      const toolCallID = "call_late_lifecycle_after_finalize"
      const toolInput = { value: "stuck" }
      lateLifecycleAfterFinalizeState.lifecycle = input.toolLifecycle
      return Stream.fromEffect(
        Effect.promise(async () => {
          await input.toolLifecycle?.started?.({ tool: "offline", toolCallID, input: toolInput })
        }),
      ).pipe(Stream.flatMap(() => Stream.fail(new Error("connection reset before late lifecycle events"))))
    },
  }),
)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

attemptTimeoutIt.live("reasoning connect watchdog is attempt-scoped for before-progress safe retry", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        capturedAttemptConnectTimeouts.length = 0
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const retrySeen = defer<SessionStatus.Info>()

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reasoning connect timeout policy")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(reasoningRef.providerID, reasoningRef.modelID)
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (evt.properties.status.type === "retry") retrySeen.resolve(evt.properties.status)
        })
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: reasoningRef.providerID, modelID: reasoningRef.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reasoning connect timeout policy" }],
          tools: {},
        })

        const retryStatus = yield* Effect.promise(() => retrySeen.promise)
        const parts = MessageV2.parts(msg.id)
        off()

        expect(value).toBe("stop")
        expect(capturedAttemptConnectTimeouts).toEqual([
          SessionProcessor.REASONING_FIRST_ATTEMPT_CONNECT_TIMEOUT_MS,
          SessionProcessor.REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS,
          SessionProcessor.REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS,
          SessionProcessor.REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS,
        ])
        expect(retryStatus).toMatchObject({
          type: "retry",
          message: "",
          presentation: "recovery",
          reason: "network_connection_dropped",
        })
        expect(handle.message.diagnostics?.run_observability?.attempts).toMatchObject([
          {
            attempt_index: 1,
            connect_timeout_ms: SessionProcessor.REASONING_FIRST_ATTEMPT_CONNECT_TIMEOUT_MS,
          },
          {
            attempt_index: 2,
            connect_timeout_ms: SessionProcessor.REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS,
          },
          {
            attempt_index: 3,
            connect_timeout_ms: SessionProcessor.REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS,
          },
          {
            attempt_index: 4,
            connect_timeout_ms: SessionProcessor.REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS,
          },
        ])
        expect(parts.some((part) => part.type === "notice" && part.kind === "safe_retry_failed")).toBe(true)
        expect(handle.message.error).toBeUndefined()

        const manualParent = yield* user(chat.id, "manual retry starts fresh")
        const manualMsg = yield* assistant(chat.id, manualParent.id, path.resolve(dir))
        const manualHandle = yield* processors.create({
          safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: manualMsg,
          sessionID: chat.id,
          model: mdl,
        })

        yield* manualHandle.process({
          user: {
            id: manualParent.id,
            sessionID: chat.id,
            role: "user",
            time: manualParent.time,
            agent: manualParent.agent,
            model: { providerID: reasoningRef.providerID, modelID: reasoningRef.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "manual retry starts fresh" }],
          tools: {},
        })

        expect(capturedAttemptConnectTimeouts).toEqual([
          SessionProcessor.REASONING_FIRST_ATTEMPT_CONNECT_TIMEOUT_MS,
          SessionProcessor.REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS,
          SessionProcessor.REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS,
          SessionProcessor.REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS,
          SessionProcessor.REASONING_FIRST_ATTEMPT_CONNECT_TIMEOUT_MS,
          SessionProcessor.REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS,
          SessionProcessor.REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS,
          SessionProcessor.REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS,
        ])
      }),
    { git: true, config: providerCfg("http://localhost:1/v1") },
  ),
)

attemptTimeoutIt.live("reasoning first attempt keeps global timeout when active tools block safe recovery", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        capturedAttemptConnectTimeouts.length = 0
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reasoning external boundary timeout policy")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(reasoningRef.providerID, reasoningRef.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })
        const externalTool = Object.assign(
          tool({
            description: "external boundary",
            inputSchema: z.object({}),
          }),
          { externalResult: true },
        )

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: reasoningRef.providerID, modelID: reasoningRef.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reasoning external boundary timeout policy" }],
          tools: {
            question: externalTool,
          },
        })

        expect(value).toBe("stop")
        expect(capturedAttemptConnectTimeouts).toEqual([ProviderTransform.REASONING_GLOBAL_CONNECT_TIMEOUT_MS])
        expect(handle.message.diagnostics?.run_observability?.attempts).toMatchObject([
          {
            attempt_index: 1,
            connect_timeout_ms: ProviderTransform.REASONING_GLOBAL_CONNECT_TIMEOUT_MS,
          },
        ])
        expect(handle.message.diagnostics?.run_observability?.incident?.recovery).toMatchObject({
          recommendation: "ask_user_before_retry",
          reason: "side_effect_facts_incomplete",
        })
      }),
    { git: true, config: providerCfg("http://localhost:1/v1") },
  ),
)

attemptTimeoutIt.live("reasoning first attempt uses fast timeout with unclassified local tool boundary", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        capturedAttemptConnectTimeouts.length = 0
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reasoning unclassified local tool timeout policy")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(reasoningRef.providerID, reasoningRef.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: reasoningRef.providerID, modelID: reasoningRef.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reasoning unclassified local tool timeout policy" }],
          tools: {
            mcp_write: tool({
              description: "ordinary local tool with incomplete effect classification",
              inputSchema: z.object({}),
            }),
          },
        })

        const parts = MessageV2.parts(msg.id)
        expect(value).toBe("stop")
        expect(capturedAttemptConnectTimeouts).toEqual([
          SessionProcessor.REASONING_FIRST_ATTEMPT_CONNECT_TIMEOUT_MS,
          SessionProcessor.REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS,
          SessionProcessor.REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS,
          SessionProcessor.REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS,
        ])
        expect(parts.some((part) => part.type === "notice" && part.kind === "safe_retry_failed")).toBe(true)
        expect(handle.message.error).toBeUndefined()
        expect(handle.message.diagnostics?.run_observability?.recovered_incidents?.[0]?.recovery).toMatchObject({
          recommendation: "auto_retry",
          reason: "no_visible_output_or_tool_execution",
        })
      }),
    { git: true, config: providerCfg("http://localhost:1/v1") },
  ),
)

it.live("session.processor keeps late tool execution diagnostics on the bound tool-call attempt", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()
        let executions = 0

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-bound-attempt",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-bound-attempt",
                object: "chat.completion.chunk",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_bound_attempt",
                          type: "function",
                          function: { name: "noop", arguments: "" },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
            stages: [
              {
                wait: gate.promise,
                chunks: [
                  {
                    id: "chatcmpl-bound-attempt",
                    object: "chat.completion.chunk",
                    choices: [
                      {
                        delta: {
                          tool_calls: [
                            {
                              index: 0,
                              function: { arguments: "{}" },
                            },
                          ],
                        },
                      },
                    ],
                  },
                  {
                    id: "chatcmpl-bound-attempt",
                    object: "chat.completion.chunk",
                    choices: [{ delta: {}, finish_reason: "tool_calls" }],
                  },
                ],
              },
            ],
          }),
        )
        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "late tool attempt binding")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })
        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
            tools: { noop: true },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "late tool attempt binding" }],
          tools: {
            noop: tool({
              description: "No-op tool",
              inputSchema: z.object({}),
              execute: async () => {
                executions += 1
                return { output: "ok" }
              },
            }),
          },
        } satisfies LLM.StreamInput

        const first = yield* handle.process(input).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* Effect.promise(async () => {
          const end = Date.now() + 500
          while (Date.now() < end) {
            const toolCallStarted = MessageV2.parts(msg.id).some(
              (part) => part.type === "tool" && part.callID === "call_bound_attempt",
            )
            if (toolCallStarted) {
              return
            }
            await Bun.sleep(10)
          }
        })
        const second = yield* handle.process(input).pipe(Effect.forkChild)
        yield* llm.wait(2)
        expect(handle.recordToolExecutionStarted).toBeDefined()
        expect(handle.recordToolExecutionCompleted).toBeDefined()
        yield* handle.recordToolExecutionStarted!({ tool: "noop", toolCallID: "call_bound_attempt", input: {} })
        yield* handle.recordToolExecutionCompleted!({ toolCallID: "call_bound_attempt" })
        gate.resolve()
        yield* Fiber.join(first)

        const stored = (yield* session.messages({ sessionID: chat.id })).find(
          (message) => message.info.role === "assistant" && message.info.id === msg.id,
        )
        expect(executions).toBe(1)
        expect(stored?.info.role).toBe("assistant")
        if (stored?.info.role === "assistant") {
          const attempts = stored.info.diagnostics?.run_observability?.attempts
          expect(attempts?.[0]).toMatchObject({
            attempt_index: 1,
            tool_execution_started: true,
            tool_execution_completed: true,
          })
          expect(attempts?.[1]).toMatchObject({
            attempt_index: 2,
            tool_execution_started: false,
            tool_execution_completed: false,
          })
        }
        yield* Fiber.interrupt(second)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor records late transport failures against the failing stream attempt", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-late-transport",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-late-transport",
                object: "chat.completion.chunk",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_late_transport",
                          type: "function",
                          function: { name: "noop", arguments: "" },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
            stages: [
              {
                wait: gate.promise,
                chunks: [
                  {
                    error: {
                      message: "stream terminated",
                      type: "invalid_request_error",
                      code: "stream_terminated",
                    },
                  },
                ],
              },
            ],
          }),
        )
        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "late transport attempt binding")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })
        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
            tools: { noop: true },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "late transport attempt binding" }],
          tools: {
            noop: tool({
              description: "No-op tool",
              inputSchema: z.object({}),
              execute: async () => ({ output: "ok" }),
            }),
          },
        } satisfies LLM.StreamInput

        const first = yield* handle.process(input).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* Effect.promise(async () => {
          const end = Date.now() + 500
          while (Date.now() < end) {
            const toolInputStarted = MessageV2.parts(msg.id).some(
              (part) => part.type === "tool" && part.callID === "call_late_transport",
            )
            if (toolInputStarted) return
            await Bun.sleep(10)
          }
        })
        const second = yield* handle.process(input).pipe(Effect.forkChild)
        yield* llm.wait(2)
        gate.resolve()
        yield* Fiber.join(first)

        const stored = (yield* session.messages({ sessionID: chat.id })).find(
          (message) => message.info.role === "assistant" && message.info.id === msg.id,
        )
        expect(stored?.info.role).toBe("assistant")
        if (stored?.info.role === "assistant") {
          const observability = stored.info.diagnostics?.run_observability
          const firstAttemptID = observability?.attempts[0]?.attempt_id
          expect(observability?.terminal_attempt_id).toBe(firstAttemptID)
          expect(observability?.incident?.phase.terminal_attempt_id).toBe(firstAttemptID)
          expect(observability?.incident?.phase).toMatchObject({
            run_phase: "tool_generation",
            stream_phase: "tool_input_generation",
            tool_phase: "tool_input_started",
          })
          expect(observability?.incident?.terminal_cause).toMatchObject({
            category: "provider_transport_disconnect",
            subcategory: "during_tool_input_generation",
          })
        }
        yield* Fiber.interrupt(second)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello", { usage: { input: 3, output: 5 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
        const trace = handle.message.diagnostics?.llm_trace
        expect(trace?.message_id).toBe(msg.id)
        expect(trace?.session_id).toBe(chat.id)
        expect(trace?.parent_message_id).toBe(parent.id)
        expect(trace?.provider).toBe("test")
        expect(trace?.model).toBe("test-model")
        expect(trace?.request).toMatchObject({
          streaming: true,
          tool_count: 0,
          small: false,
          reasoning_capability: false,
        })
        expect(trace?.stream_events.text_delta).toBeGreaterThan(0)
        expect(trace?.stream_events.reasoning_delta).toBe(0)
        expect(trace?.stored_parts.text).toBeGreaterThan(0)
        expect(trace?.stored_parts.reasoning).toBe(0)
        expect(trace?.tokens?.output).toBeGreaterThan(0)
        expect(trace?.flags.empty_completion).toBe(false)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const stop = Date.now() + 500
          while (Date.now() < stop) {
            const text = MessageV2.parts(msg.id).find((part): part is MessageV2.TextPart => part.type === "text")
            if (text?.time?.start) return
            await Bun.sleep(10)
          }
          throw new Error("timed out waiting for text part")
        })
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = MessageV2.parts(msg.id).find((part): part is MessageV2.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests flag empty completions", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "empty")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "empty" }],
          tools: {},
        })

        expect(value).toBe("continue")
        expect(MessageV2.parts(msg.id).some((part) => part.type === "text" || part.type === "reasoning")).toBe(false)
        expect(handle.message.diagnostics?.llm_trace?.flags.empty_completion).toBe(true)
        expect(handle.message.diagnostics?.llm_trace?.stream_events.finish_step).toBe(1)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is MessageV2.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is MessageV2.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
        expect(handle.message.diagnostics?.llm_trace?.stream_events.reasoning_delta).toBeGreaterThan(0)
        expect(handle.message.diagnostics?.llm_trace?.stored_parts.reasoning).toBe(1)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is MessageV2.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        // Bun harness cannot produce Node undici's UND_ERR_SOCKET shape; TCP reset
        // covers the processor retry/replay chain, classifier unit tests cover the rest.
        const reasoningTexts = reasoning.map((part) => part.text)
        expect(reasoningTexts).toContain("two")
        expect(reasoningTexts).not.toContain("one")
        expect(reasoningTexts).not.toContain("onetwo")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
        expect(handle.message.diagnostics?.llm_trace?.flags.stream_error).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("retryable API errors write a safe retry notice after the recovery retries are exhausted", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(503, { error: "temporarily unavailable" })
        yield* llm.error(503, { error: "still unavailable" })
        yield* llm.error(503, { error: "still unavailable" })
        yield* llm.error(503, { error: "still unavailable" })
        yield* llm.text("recovered attempt should not run")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry api twice")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry api twice" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(4)
        expect(parts.some((part) => part.type === "text" && part.text === "recovered attempt should not run")).toBe(false)
        expect(parts.some((part) => part.type === "notice" && part.kind === "safe_retry_failed")).toBe(true)
        expect(handle.message.error).toBeUndefined()
        expect(handle.message.diagnostics?.run_observability?.attempts).toHaveLength(4)
        expect(handle.message.diagnostics?.run_observability?.recovered_incidents).toHaveLength(3)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (evt.properties.status.type === "retry") states.push(evt.properties.status.attempt)
        })
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        off()

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("connect timeout before provider progress auto retries once and succeeds", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.hang
        yield* llm.text("after retry")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "auto retry connect timeout")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "auto retry connect timeout" }],
          tools: {},
          connectTimeoutMs: 20,
          streamTimeoutMs: 1_000,
        })

        const parts = MessageV2.parts(msg.id)
        const stored = (yield* session.messages({ sessionID: chat.id })).find(
          (message) => message.info.role === "assistant" && message.info.id === msg.id,
        )

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after retry")).toBe(true)
        expect(handle.message.error).toBeUndefined()
        expect(stored?.info.role).toBe("assistant")
        if (stored?.info.role === "assistant") {
          expect(stored.info.error).toBeUndefined()
          const observability = stored.info.diagnostics?.run_observability
          expect(observability?.classification).toBe("success")
          expect(String(observability?.summary_key)).toBe("success.completed")
          expect(observability?.terminal_attempt_id).toBeUndefined()
          expect(observability?.incident).toBeUndefined()
          expect(observability?.recovered_incidents?.[0]?.terminal_cause).toMatchObject({
            category: "watchdog_timeout",
            subcategory: "connect",
          })
          expect(observability?.recovered_incidents?.[0]?.recovery).toMatchObject({
            recommendation: "auto_retry",
            reason: "no_visible_output_or_tool_execution",
          })
          expect(observability?.attempts).toHaveLength(2)
          expect(observability?.attempts[0]).toMatchObject({
            attempt_index: 1,
            provider_progress_seen: false,
            visible_output_seen: false,
            tool_call_materialized: false,
            tool_execution_started: false,
          })
          expect(observability?.attempts[1]).toMatchObject({
            attempt_index: 2,
            visible_output_seen: true,
          })
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("connect timeout auto retry stops if lifecycle closes during backoff", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const retrySeen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        yield* llm.hang
        yield* llm.text("should not run")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "auto retry lifecycle close")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (evt.properties.status.type === "retry") retrySeen.resolve()
        })
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "auto retry lifecycle close" }],
            tools: {},
            connectTimeoutMs: 20,
            streamTimeoutMs: 1_000,
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(() => retrySeen.promise)
        const action = createLifecycleCloseAction("instance_reload", {
          affectedDirectories: [path.resolve(dir)],
          origin: { source: "runtime", operation: "instance.reload", reason: "test_retry_backoff" },
        })
        yield* Effect.promise(() =>
          withLifecycleCloseAction([path.resolve(dir)], action, async () => {
            await Bun.sleep(3_000)
          }),
        )
        const value = yield* Fiber.join(run)
        off()

        const stored = (yield* session.messages({ sessionID: chat.id })).find(
          (message) => message.info.role === "assistant" && message.info.id === msg.id,
        )
        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(stored?.info.role).toBe("assistant")
        if (stored?.info.role === "assistant") {
          expect(stored.info.error?.data.message).toContain("local lifecycle close")
          expect(stored.info.error?.data.message).not.toContain("provider connection")
          expect(stored.info.diagnostics?.run_observability?.incident?.facts.lifecycle_close_seen).toBe(true)
          expect(stored.info.diagnostics?.run_observability?.incident?.recovery).toMatchObject({
            recommendation: "do_not_retry",
            reason: "local_lifecycle_close",
          })
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("maintenance lifecycle close during backoff interrupts safe recovery", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const retrySeen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        yield* llm.hang
        yield* llm.text("should not run")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "maintenance close during backoff")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (evt.properties.status.type === "retry") retrySeen.resolve()
        })
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "maintenance close during backoff" }],
            tools: {},
            connectTimeoutMs: 20,
            streamTimeoutMs: 1_000,
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(() => retrySeen.promise)
        const releaseClose = beginLifecycleClose([path.resolve(dir)])
        yield* Fiber.join(run)
        releaseClose()
        off()

        const stored = (yield* session.messages({ sessionID: chat.id })).find(
          (message) => message.info.role === "assistant" && message.info.id === msg.id,
        )
        expect(yield* llm.calls).toBe(1)
        expect(stored?.info.role).toBe("assistant")
        if (stored?.info.role === "assistant") {
          expect(stored.info.error?.data.message).toContain("lifecycle close")
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("lifecycle close waiter is cleaned up after normal backoff completion", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.hang
        yield* llm.hang
        yield* llm.hang
        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "waiter cleanup check")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const before = closingStartWaiterCount()
        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "waiter cleanup check" }],
          tools: {},
          connectTimeoutMs: 20,
          streamTimeoutMs: 1_000,
        })

        expect(closingStartWaiterCount()).toBe(before)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("connect timeout auto retry records abort if interrupted during backoff", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const retrySeen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        yield* llm.hang
        yield* llm.text("should not run")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "auto retry backoff interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (evt.properties.status.type === "retry") retrySeen.resolve()
        })
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "auto retry backoff interrupt" }],
            tools: {},
            connectTimeoutMs: 20,
            streamTimeoutMs: 1_000,
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(() => retrySeen.promise)
        yield* Fiber.interrupt(run)
        const exit = yield* Fiber.await(run)
        off()

        const stored = (yield* session.messages({ sessionID: chat.id })).find(
          (message) => message.info.role === "assistant" && message.info.id === msg.id,
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored?.info.role).toBe("assistant")
        if (stored?.info.role === "assistant") {
          const observability = stored.info.diagnostics?.run_observability
          expect(stored.info.error?.name).toBe("MessageAbortedError")
          expect(observability?.classification).not.toBe("success")
          expect(String(observability?.summary_key)).not.toBe("success.completed")
          expect(observability?.recovered_incidents).toBeUndefined()
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("disabled unknown tools do not block safe connect-timeout auto retry", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.hang
        yield* llm.text("after retry")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "disabled unknown tool retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
            tools: { mcp_write: false },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "disabled unknown tool retry" }],
          tools: {
            read: tool({
              description: "read",
              inputSchema: z.object({}),
            }),
            mcp_write: tool({
              description: "unknown disabled tool",
              inputSchema: z.object({}),
            }),
          },
          connectTimeoutMs: 250,
          streamTimeoutMs: 1_000,
        })

        const stored = (yield* session.messages({ sessionID: chat.id })).find(
          (message) => message.info.role === "assistant" && message.info.id === msg.id,
        )
        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(stored?.info.role).toBe("assistant")
        if (stored?.info.role === "assistant") {
          const snapshot = stored.info.diagnostics?.run_observability?.side_effect_boundary_snapshot
          expect(snapshot).toMatchObject({
            exposed_tool_count: 1,
            unknown_tool_count: 0,
            unclassified_effect_count: 0,
            proof_result: "complete",
          })
          expect(stored.info.diagnostics?.run_observability?.recovered_incidents?.[0]?.recovery).toMatchObject({
            recommendation: "auto_retry",
            reason: "no_visible_output_or_tool_execution",
          })
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("reasoning-only retry removes failed reasoning before replaying the assistant message", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const retrySeen = defer<SessionStatus.Info>()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-reasoning-retry",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-reasoning-retry",
                object: "chat.completion.chunk",
                choices: [{ delta: { reasoning_content: "failed draft" } }],
              },
            ],
            tail: [
              {
                error: {
                  message: "rate limit",
                  type: "server_error",
                  code: "rate_limit",
                },
              },
            ],
          }),
        )
        yield* llm.text("after retry")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reasoning retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (evt.properties.status.type === "retry") retrySeen.resolve(evt.properties.status)
        })
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reasoning retry" }],
          tools: {
            mcp_write: tool({
              description: "unknown local boundary",
              inputSchema: z.object({}),
            }),
          },
        })

        const parts = MessageV2.parts(msg.id)
        const retryStatus = yield* Effect.promise(() => retrySeen.promise)
        const stored = (yield* session.messages({ sessionID: chat.id })).find(
          (message) => message.info.role === "assistant" && message.info.id === msg.id,
        )
        off()

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(retryStatus).toMatchObject({
          type: "retry",
          message: "",
          presentation: "recovery",
          reason: "network_connection_dropped",
        })
        expect(parts.some((part) => part.type === "reasoning")).toBe(false)
        expect(parts.some((part) => part.type === "reasoning" && part.text === "failed draft")).toBe(false)
        expect(parts.some((part) => part.type === "text" && part.text === "after retry")).toBe(true)
        expect(stored?.info.role).toBe("assistant")
        if (stored?.info.role === "assistant") {
          expect(stored.info.error).toBeUndefined()
          expect(stored.info.diagnostics?.run_observability?.recovered_incidents?.[0]?.recovery).toMatchObject({
            recommendation: "auto_retry",
            reason: "reasoning_only_without_final_text_or_tool_activity",
          })
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("reasoning-only failure with an external-result tool does not auto retry", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-external-boundary",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-external-boundary",
                object: "chat.completion.chunk",
                choices: [{ delta: { reasoning_content: "draft" } }],
              },
            ],
            tail: [
              {
                error: {
                  message: "rate limit",
                  type: "server_error",
                  code: "rate_limit",
                },
              },
            ],
          }),
        )
        yield* llm.text("after retry should not run")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "external boundary retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const externalTool = Object.assign(
          tool({
            description: "external boundary",
            inputSchema: z.object({}),
          }),
          { externalResult: true },
        )
        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "external boundary retry" }],
          tools: {
            question: externalTool,
          },
        })

        const stored = (yield* session.messages({ sessionID: chat.id })).find(
          (message) => message.info.role === "assistant" && message.info.id === msg.id,
        )

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(stored?.info.role).toBe("assistant")
        if (stored?.info.role === "assistant") {
          expect(stored.info.diagnostics?.run_observability?.side_effect_boundary_snapshot).toMatchObject({
            external_boundary_present: true,
            proof_reason: "external_boundary",
          })
          expect(stored.info.diagnostics?.run_observability?.incident?.recovery).toMatchObject({
            recommendation: "ask_user_before_retry",
            reason: "side_effect_facts_incomplete",
          })
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("reasoning-only failure with a provider-executed tool does not auto retry", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-provider-boundary",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-provider-boundary",
                object: "chat.completion.chunk",
                choices: [{ delta: { reasoning_content: "draft" } }],
              },
            ],
            tail: [
              {
                error: {
                  message: "rate limit",
                  type: "server_error",
                  code: "rate_limit",
                },
              },
            ],
          }),
        )
        yield* llm.text("after retry should not run")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider boundary retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "provider boundary retry" }],
          tools: {
            web_search: {
              type: "provider",
              id: "openai.web_search",
              args: {},
              inputSchema: z.object({}),
            } as any,
          },
        })

        const stored = (yield* session.messages({ sessionID: chat.id })).find(
          (message) => message.info.role === "assistant" && message.info.id === msg.id,
        )

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(stored?.info.role).toBe("assistant")
        if (stored?.info.role === "assistant") {
          expect(stored.info.diagnostics?.run_observability?.side_effect_boundary_snapshot).toMatchObject({
            provider_executed_capability_present: true,
            proof_reason: "provider_executed_capability",
          })
          expect(stored.info.diagnostics?.run_observability?.incident?.recovery).toMatchObject({
            recommendation: "ask_user_before_retry",
            reason: "side_effect_facts_incomplete",
          })
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("reasoning-only retry writes a notice after the safe retries are exhausted", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        for (const suffix of ["first", "second", "third", "fourth"]) {
          yield* llm.push(
            raw({
              head: [
                {
                  id: `chatcmpl-reasoning-retry-${suffix}`,
                  object: "chat.completion.chunk",
                  choices: [{ delta: { role: "assistant" } }],
                },
                {
                  id: `chatcmpl-reasoning-retry-${suffix}`,
                  object: "chat.completion.chunk",
                  choices: [{ delta: { reasoning_content: `${suffix} failed draft` } }],
                },
              ],
              tail: [
                {
                  error: {
                    message: "rate limit",
                    type: "server_error",
                    code: "rate_limit",
                  },
                },
              ],
            }),
          )
        }
        yield* llm.text("recovered attempt should not run")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reasoning retry fails twice")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reasoning retry fails twice" }],
          tools: {
            mcp_write: tool({
              description: "unknown local boundary",
              inputSchema: z.object({}),
            }),
          },
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(4)
        expect(parts.some((part) => part.type === "reasoning")).toBe(false)
        expect(parts.some((part) => part.type === "text" && part.text === "recovered attempt should not run")).toBe(false)
        expect(parts.some((part) => part.type === "notice" && part.kind === "safe_retry_failed")).toBe(true)
        expect(handle.message.error).toBeUndefined()
        expect(handle.message.diagnostics?.run_observability?.recovered_incidents).toHaveLength(3)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("retryable stream error after visible output does not replay the assistant message", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-visible-retry-guard",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-visible-retry-guard",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "visible" } }],
              },
            ],
            tail: [
              {
                error: {
                  message: "stream terminated",
                  type: "server_error",
                  code: "stream_terminated",
                },
              },
            ],
          }),
        )
        yield* llm.text("replayed")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "visible output retry guard")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "visible output retry guard" }],
          tools: {},
        })

        const textParts = MessageV2.parts(msg.id).filter((part): part is MessageV2.TextPart => part.type === "text")
        const stored = (yield* session.messages({ sessionID: chat.id })).find(
          (message) => message.info.role === "assistant" && message.info.id === msg.id,
        )

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(textParts.map((part) => part.text)).toContain("visible")
        expect(textParts.map((part) => part.text)).not.toContain("replayed")
        expect(stored?.info.role).toBe("assistant")
        if (stored?.info.role === "assistant") {
          expect(stored.info.error?.data.message).toContain("Connection lost during response")
          expect(stored.info.error?.data.message).not.toContain("stream terminated")
          expect(stored.info.diagnostics?.run_observability?.incident?.recovery).toMatchObject({
            recommendation: "offer_continue",
            reason: "visible_output_without_tool_execution",
          })
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop structured context overflow when auto compaction is disabled", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "no auto compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "no auto compact json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("ContextOverflowError")
      }),
    { git: true, config: (url) => providerCfgWithDisabledAutoCompaction(url) },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Effect.promise(async () => {
          const end = Date.now() + 500
          while (Date.now() < end) {
            const parts = await MessageV2.parts(msg.id)
            if (parts.some((part) => part.type === "tool")) return
            await Bun.sleep(10)
          }
        })
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = MessageV2.parts(msg.id)
        const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        const stored = (yield* session.messages({ sessionID: chat.id })).find(
          (message) => message.info.role === "assistant" && message.info.id === msg.id,
        )

        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool call generation interrupted before the tool ran.")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.metadata?.interruption_phase).toBe("tool_input_generation")
          expect(call.state.metadata?.tool_execution_started).toBe(false)
          expect(call.state.time.end).toBeDefined()
        }
        expect(stored?.info.role).toBe("assistant")
        if (stored?.info.role === "assistant") {
          const observability = stored.info.diagnostics?.run_observability
          expect(observability?.tool_execution_started).toBe(false)
          expect(observability?.pending_tool_parts_interrupted).toBe(1)
          expect(observability?.incident?.terminal_cause.category).not.toBe("tool_execution_interrupted")
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark materialized tools as prepared but not run on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_materialized_without_execution",
                          type: "function",
                          function: { name: "bash", arguments: "" },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          function: { arguments: JSON.stringify({ cmd: "pwd" }) },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
              },
            ],
            hang: true,
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "materialized tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
              tools: { bash: true },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "materialized tool abort" }],
            tools: {
              bash: tool({
                description: "Run a shell command",
                inputSchema: z.object({ cmd: z.string() }),
              }),
            },
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Effect.promise(async () => {
          const end = Date.now() + 500
          while (Date.now() < end) {
            const parts = await MessageV2.parts(msg.id)
            if (parts.some((part) => part.type === "tool" && part.state.status === "running")) return
            await Bun.sleep(10)
          }
        })
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = MessageV2.parts(msg.id)
        const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
        const stored = (yield* session.messages({ sessionID: chat.id })).find(
          (message) => message.info.role === "assistant" && message.info.id === msg.id,
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool call was prepared, but the tool did not run before the interruption.")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.metadata?.interruption_phase).toBe("tool_call_materialized_without_execution")
          expect(call.state.metadata?.tool_execution_started).toBe(false)
        }
        expect(stored?.info.role).toBe("assistant")
        if (stored?.info.role === "assistant") {
          const observability = stored.info.diagnostics?.run_observability
          expect(observability?.tool_execution_started).toBe(false)
          expect(observability?.pending_tool_parts_interrupted).toBe(1)
          expect(observability?.incident?.terminal_cause.category).not.toBe("tool_execution_interrupted")
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests persists completed tool result after provider stream timeout", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const toolStarted = defer<void>()
        const toolFinish = defer<void>()
        let executions = 0
        let toolAbortSignalAborted: boolean | undefined

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_stream_timeout_tool",
                          type: "function",
                          function: { name: "slow", arguments: "" },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          function: { arguments: JSON.stringify({ value: "ok" }) },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
              },
            ],
            hang: true,
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "stream reset during tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
              tools: { slow: true },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "stream reset during tool" }],
            streamTimeoutMs: 200,
            tools: {
              slow: tool({
                description: "Complete after the provider stream has failed",
                inputSchema: z.object({ value: z.string() }),
                execute: async (_args, options) => {
                  executions += 1
                  toolStarted.resolve()
                  await toolFinish.promise
                  toolAbortSignalAborted = options.abortSignal?.aborted ?? false
                  return { output: "slow result", title: "slow", metadata: { marker: "drained" } }
                },
              }),
            },
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(() => toolStarted.promise)
        yield* Effect.promise(() => Bun.sleep(1_200))
        toolFinish.resolve()

        yield* Fiber.join(run)
        const parts = MessageV2.parts(msg.id)
        const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
        const stored = (yield* session.messages({ sessionID: chat.id })).find(
          (message) => message.info.role === "assistant" && message.info.id === msg.id,
        )

        expect(executions).toBe(1)
        expect(toolAbortSignalAborted).toBe(false)
        expect(call?.state.status).toBe("completed")
        if (call?.state.status === "completed") {
          expect(call.state.output).toBe("slow result")
          expect(call.state.metadata?.marker).toBe("drained")
          expect(call.state.metadata?.interrupted).toBeUndefined()
        }
        expect(stored?.info.role).toBe("assistant")
        if (stored?.info.role === "assistant") {
          const observability = stored.info.diagnostics?.run_observability
          expect(observability?.tool_execution_started).toBe(true)
          expect(observability?.attempts?.[0]?.tool_execution_completed).toBe(true)
          expect(observability?.pending_tool_parts_interrupted).toBeUndefined()
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

noStreamToolCompletionIt.live(
  "session.processor effect tests synthesizes completed tool part when stream disconnects before tool events",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          noStreamToolCompletionFailures.length = 0
          const { processors, session, provider } = yield* boot()

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "no stream tool completion")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
              tools: { offline: true },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "no stream tool completion" }],
            toolDrainTimeoutMs: 5_000,
            tools: {
              offline: tool({
                description: "Fake LLM drives lifecycle directly in this test",
                inputSchema: z.object({ value: z.string() }),
                execute: async () => ({ output: "unused" }),
              }),
            },
          })

          const toolParts = MessageV2.parts(msg.id).filter((part): part is MessageV2.ToolPart => part.type === "tool")
          const storedMessages = yield* session.messages({ sessionID: chat.id })
          const modelMessages = yield* MessageV2.toModelMessagesEffect(storedMessages, mdl)
          const assistantModelMessage = modelMessages.find((message) => message.role === "assistant")
          const toolModelContent =
            assistantModelMessage && Array.isArray(assistantModelMessage.content)
              ? assistantModelMessage.content.find(
                  (part) => part.type === "tool-call" && part.toolCallId === "call_no_stream_tool_completion",
                )
              : undefined

          expect(noStreamToolCompletionFailures).toEqual([])
          expect(toolParts).toHaveLength(1)
          expect(toolParts[0]?.state.status).toBe("completed")
          if (toolParts[0]?.state.status === "completed") {
            expect(toolParts[0].tool).toBe("offline")
            expect(toolParts[0].state.input).toEqual({ value: "ok" })
            expect(toolParts[0].state.output).toBe("offline result")
            expect(toolParts[0].state.metadata?.marker).toBe("no-stream")
            expect(toolParts[0].state.metadata?.interrupted).toBeUndefined()
          }
          expect(toolModelContent).toMatchObject({
            type: "tool-call",
            toolCallId: "call_no_stream_tool_completion",
            input: { value: "ok" },
          })
        }),
      { git: true, config: providerCfg("http://localhost:1/v1") },
    ),
)

noStreamToolFailureIt.live(
  "session.processor effect tests synthesizes failed tool part when stream disconnects before tool events",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          noStreamToolFailureFailures.length = 0
          const { processors, session, provider } = yield* boot()

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "no stream tool failure")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
              tools: { offline: true },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "no stream tool failure" }],
            toolDrainTimeoutMs: 5_000,
            tools: {
              offline: tool({
                description: "Fake LLM drives lifecycle directly in this test",
                inputSchema: z.object({ value: z.string() }),
                execute: async () => ({ output: "unused" }),
              }),
            },
          })

          const toolParts = MessageV2.parts(msg.id).filter((part): part is MessageV2.ToolPart => part.type === "tool")
          const storedMessages = yield* session.messages({ sessionID: chat.id })
          const modelMessages = yield* MessageV2.toModelMessagesEffect(storedMessages, mdl)
          const assistantModelMessage = modelMessages.find((message) => message.role === "assistant")
          const toolModelContent =
            assistantModelMessage && Array.isArray(assistantModelMessage.content)
              ? assistantModelMessage.content.find(
                  (part) => part.type === "tool-call" && part.toolCallId === "call_no_stream_tool_failure",
                )
              : undefined

          expect(noStreamToolFailureFailures).toEqual([])
          expect(toolParts).toHaveLength(1)
          expect(toolParts[0]?.state.status).toBe("error")
          if (toolParts[0]?.state.status === "error") {
            expect(toolParts[0].tool).toBe("offline")
            expect(toolParts[0].state.input).toEqual({ value: "bad" })
            expect(toolParts[0].state.error).toContain("offline failure")
            expect(toolParts[0].state.metadata?.interrupted).toBeUndefined()
          }
          expect(toolModelContent).toMatchObject({
            type: "tool-call",
            toolCallId: "call_no_stream_tool_failure",
            input: { value: "bad" },
          })
        }),
      { git: true, config: providerCfg("http://localhost:1/v1") },
    ),
)

noStreamDeadToolIt.live(
  "session.processor effect tests synthesizes interrupted tool part when dead execution has no stream events",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "no stream dead tool")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
              tools: { offline: true },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "no stream dead tool" }],
            toolDrainTimeoutMs: 25,
            tools: {
              offline: tool({
                description: "Fake LLM starts lifecycle then disconnects before stream tool events",
                inputSchema: z.object({ value: z.string() }),
                execute: async () => ({ output: "unused" }),
              }),
            },
          })

          const toolParts = MessageV2.parts(msg.id).filter((part): part is MessageV2.ToolPart => part.type === "tool")
          const storedMessages = yield* session.messages({ sessionID: chat.id })
          const modelMessages = yield* MessageV2.toModelMessagesEffect(storedMessages, mdl)
          const assistantModelMessage = modelMessages.find((message) => message.role === "assistant")
          const toolModelCall =
            assistantModelMessage && Array.isArray(assistantModelMessage.content)
              ? assistantModelMessage.content.find(
                  (part) => part.type === "tool-call" && part.toolCallId === "call_no_stream_dead_tool",
                )
              : undefined
          const toolModelResult = modelMessages
            .find((message) => message.role === "tool")
            ?.content.find((part) => part.type === "tool-result" && part.toolCallId === "call_no_stream_dead_tool")

          expect(toolParts).toHaveLength(1)
          expect(toolParts[0]?.state.status).toBe("error")
          if (toolParts[0]?.state.status === "error") {
            expect(toolParts[0].tool).toBe("offline")
            expect(toolParts[0].state.input).toEqual({ value: "stuck" })
            expect(toolParts[0].state.error).toContain("may have started or completed")
            expect(toolParts[0].state.error).toContain("do not repeat")
            expect(toolParts[0].state.metadata?.interrupted).toBe(true)
            expect(toolParts[0].state.metadata?.interruption_phase).toBe("tool_execution")
            expect(toolParts[0].state.metadata?.tool_execution_started).toBe(true)
          }
          expect(toolModelCall).toMatchObject({
            type: "tool-call",
            toolCallId: "call_no_stream_dead_tool",
            toolName: "offline",
            input: { value: "stuck" },
          })
          expect(toolModelResult).toMatchObject({
            type: "tool-result",
            toolCallId: "call_no_stream_dead_tool",
            toolName: "offline",
            output: {
              type: "error-text",
              value: expect.stringContaining("do not repeat"),
            },
          })
          const stored = storedMessages.find(
            (message) => message.info.role === "assistant" && message.info.id === msg.id,
          )
          expect(stored?.info.role).toBe("assistant")
          if (stored?.info.role === "assistant") {
            expect(stored.info.error).toBeUndefined()
            const evidence: Array<{ event_type: string; order: number }> =
              stored.info.diagnostics?.run_observability?.incident?.evidence ?? []
            const interruptedOrder = evidence.find((event) => event.event_type === "tool_execution_interrupted")?.order
            const recoveryOrder = evidence.find((event) => event.event_type === "recovery_decision")?.order
            expect(interruptedOrder).toBeDefined()
            expect(recoveryOrder).toBeDefined()
            expect(interruptedOrder!).toBeLessThan(recoveryOrder!)
          }
        }),
      { git: true, config: providerCfg("http://localhost:1/v1") },
    ),
)

lateLifecycleAfterFinalizeIt.live(
  "session.processor effect tests ignores late lifecycle callbacks after tool finalization",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          lateLifecycleAfterFinalizeState.lifecycle = undefined
          const { processors, session, provider } = yield* boot()

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "late lifecycle after finalize")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
              tools: { offline: true },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "late lifecycle after finalize" }],
            toolDrainTimeoutMs: 25,
            tools: {
              offline: tool({
                description: "Fake LLM starts lifecycle then disconnects before terminal lifecycle",
                inputSchema: z.object({ value: z.string() }),
                execute: async () => ({ output: "unused" }),
              }),
            },
          })

          const lifecycle = lateLifecycleAfterFinalizeState.lifecycle as CapturedToolLifecycle | undefined
          const completed = lifecycle?.completed
          const failed = lifecycle?.failed
          if (!completed || !failed) throw new Error("tool lifecycle callbacks were not captured")
          const completedExit = yield* Effect.exit(
            Effect.promise(() =>
              Promise.resolve(
                completed({
                  toolCallID: "call_late_lifecycle_after_finalize",
                  output: {
                    title: "offline",
                    metadata: { marker: "late-complete" },
                    output: "late output",
                  },
                }),
              ),
            ).pipe(Effect.timeout("250 millis")),
          )
          const failedExit = yield* Effect.exit(
            Effect.promise(() =>
              Promise.resolve(
                failed({
                  toolCallID: "call_late_lifecycle_after_finalize",
                  error: new Error("late failure"),
                }),
              ),
            ).pipe(Effect.timeout("250 millis")),
          )

          const toolParts = MessageV2.parts(msg.id).filter((part): part is MessageV2.ToolPart => part.type === "tool")
          expect(Exit.isSuccess(completedExit)).toBe(true)
          expect(Exit.isSuccess(failedExit)).toBe(true)
          expect(toolParts).toHaveLength(1)
          expect(toolParts[0]?.state.status).toBe("error")
          if (toolParts[0]?.state.status === "error") {
            expect(toolParts[0].state.input).toEqual({ value: "stuck" })
            expect(toolParts[0].state.error).toContain("do not repeat")
            expect(toolParts[0].state.metadata?.interrupted).toBe(true)
            expect(toolParts[0].state.metadata?.interruption_phase).toBe("tool_execution")
            expect(toolParts[0].state.metadata?.marker).toBeUndefined()
          }
        }),
      { git: true, config: providerCfg("http://localhost:1/v1") },
    ),
)

it.live("session.processor effect tests waits for fast completed tool materialization before cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        let executions = 0
        let toolAbortSignalAborted: boolean | undefined

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_fast_completed_tool",
                          type: "function",
                          function: { name: "fast", arguments: "" },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          function: { arguments: JSON.stringify({ value: "ok" }) },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
              },
            ],
            hang: true,
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "fast tool during stream reset")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
            tools: { fast: true },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "fast tool during stream reset" }],
          streamTimeoutMs: 200,
          tools: {
            fast: tool({
              description: "Completes immediately",
              inputSchema: z.object({ value: z.string() }),
              execute: async (_args, options) => {
                executions += 1
                toolAbortSignalAborted = options.abortSignal?.aborted ?? false
                return { output: "fast result", title: "fast", metadata: { marker: "fast-drained" } }
              },
            }),
          },
        })

        const parts = MessageV2.parts(msg.id)
        const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
        const stored = (yield* session.messages({ sessionID: chat.id })).find(
          (message) => message.info.role === "assistant" && message.info.id === msg.id,
        )

        expect(executions).toBe(1)
        expect(toolAbortSignalAborted).toBe(false)
        expect(call?.state.status).toBe("completed")
        if (call?.state.status === "completed") {
          expect(call.state.output).toBe("fast result")
          expect(call.state.metadata?.marker).toBe("fast-drained")
          expect(call.state.metadata?.interrupted).toBeUndefined()
        }
        expect(stored?.info.role).toBe("assistant")
        if (stored?.info.role === "assistant") {
          expect(stored.info.error).toBeUndefined()
          const observability = stored.info.diagnostics?.run_observability
          expect(observability?.tool_execution_started).toBe(true)
          expect(observability?.attempts?.[0]?.tool_execution_completed).toBe(true)
          expect(observability?.pending_tool_parts_interrupted).toBeUndefined()
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

lifecycleBeforeToolEventIt.live(
  "session.processor effect tests persists tool completion when lifecycle beats stream materialization",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          lifecycleBeforeToolEventFailures.length = 0
          const { processors, session, provider } = yield* boot()

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "lifecycle before stream materialization")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
              tools: { fast: true },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "lifecycle before stream materialization" }],
            toolDrainTimeoutMs: 100,
            tools: {
              fast: tool({
                description: "Fake LLM drives lifecycle directly in this test",
                inputSchema: z.object({ value: z.string() }),
                execute: async () => ({ output: "unused" }),
              }),
            },
          })

          const toolParts = MessageV2.parts(msg.id).filter((part): part is MessageV2.ToolPart => part.type === "tool")
          const call = toolParts.find((part) => part.callID === "call_lifecycle_before_event")
          const storedMessages = yield* session.messages({ sessionID: chat.id })
          const modelMessages = yield* MessageV2.toModelMessagesEffect(storedMessages, mdl)
          const assistantModelMessage = modelMessages.find((message) => message.role === "assistant")
          const toolModelContent =
            assistantModelMessage && Array.isArray(assistantModelMessage.content)
              ? assistantModelMessage.content.find(
                  (part) => part.type === "tool-call" && part.toolCallId === "call_lifecycle_before_event",
                )
              : undefined
          expect(lifecycleBeforeToolEventFailures).toEqual([])
          expect(toolParts.filter((part) => part.callID === "call_lifecycle_before_event")).toHaveLength(1)
          expect(call?.state.status).toBe("completed")
          if (call?.state.status === "completed") {
            expect(call.state.input).toEqual({ value: "ok" })
            expect(call.state.output).toBe("fast result")
            expect(call.state.metadata?.marker).toBe("lifecycle-first")
            expect(call.state.metadata?.interrupted).toBeUndefined()
          }
          expect(toolModelContent).toMatchObject({
            type: "tool-call",
            toolCallId: "call_lifecycle_before_event",
            input: { value: "ok" },
          })
        }),
      { git: true, config: providerCfg("http://localhost:1/v1") },
    ),
)

it.live("session.processor effect tests keeps abort-aware executing tools interrupted on process abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const toolStarted = defer<void>()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_abort_aware_tool",
                          type: "function",
                          function: { name: "slow", arguments: "" },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          function: { arguments: JSON.stringify({ value: "ok" }) },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
              },
            ],
            hang: true,
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort executing tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
              tools: { slow: true },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort executing tool" }],
            tools: {
              slow: tool({
                description: "Rejects when the processor aborts the tool signal",
                inputSchema: z.object({ value: z.string() }),
                execute: async (_args, options) => {
                  toolStarted.resolve()
                  await new Promise<never>((_, reject) => {
                    options.abortSignal?.addEventListener(
                      "abort",
                      () => reject(new DOMException("Tool cancelled", "AbortError")),
                      { once: true },
                    )
                  })
                },
              }),
            },
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(() => toolStarted.promise)
        yield* Fiber.interrupt(run)

        const call = MessageV2.parts(msg.id).find((part): part is MessageV2.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.metadata?.interruption_phase).toBe("tool_execution")
          expect(call.state.metadata?.tool_execution_started).toBe(true)
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests bounds drain for dead tools after provider stream timeout", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const toolStarted = defer<void>()
        let executions = 0

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_dead_tool",
                          type: "function",
                          function: { name: "dead", arguments: "" },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          function: { arguments: JSON.stringify({ value: "ok" }) },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
              },
            ],
            hang: true,
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "dead tool after stream timeout")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
              tools: { dead: true },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "dead tool after stream timeout" }],
            streamTimeoutMs: 100,
            toolDrainTimeoutMs: 100,
            tools: {
              dead: tool({
                description: "Never resolves",
                inputSchema: z.object({ value: z.string() }),
                execute: async () => {
                  executions += 1
                  toolStarted.resolve()
                  await new Promise<never>(() => {})
                },
              }),
            },
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(() => toolStarted.promise)
        yield* Fiber.join(run)

        const call = MessageV2.parts(msg.id).find((part): part is MessageV2.ToolPart => part.type === "tool")
        expect(executions).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toContain("do not repeat")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.metadata?.interruption_phase).toBe("tool_execution")
          expect(call.state.metadata?.tool_execution_started).toBe(true)
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests aborts tools while cleanup is draining", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const toolStarted = defer<void>()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_drain_abort_tool",
                          type: "function",
                          function: { name: "slow", arguments: "" },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          function: { arguments: JSON.stringify({ value: "ok" }) },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
              },
            ],
            hang: true,
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort cleanup drain")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
              tools: { slow: true },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort cleanup drain" }],
            streamTimeoutMs: 100,
            toolDrainTimeoutMs: 5_000,
            tools: {
              slow: tool({
                description: "Rejects when cleanup drain is aborted",
                inputSchema: z.object({ value: z.string() }),
                execute: async (_args, options) => {
                  toolStarted.resolve()
                  await new Promise<never>((_, reject) => {
                    options.abortSignal?.addEventListener(
                      "abort",
                      () => reject(new DOMException("Tool cancelled", "AbortError")),
                      { once: true },
                    )
                  })
                },
              }),
            },
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(() => toolStarted.promise)
        yield* Effect.promise(() => Bun.sleep(400))
        const abortStarted = Date.now()
        expect(handle.abortTools).toBeDefined()
        yield* handle.abortTools!()
        yield* Fiber.join(run)

        expect(Date.now() - abortStarted).toBeLessThan(2_500)
        const call = MessageV2.parts(msg.id).find((part): part is MessageV2.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.metadata?.interruption_phase).toBe("tool_execution")
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests execute Responses args-done-only tool calls", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const previousToken = process.env.GITHUB_COPILOT_TOKEN
        process.env.GITHUB_COPILOT_TOKEN = "test-copilot-token"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousToken === undefined) delete process.env.GITHUB_COPILOT_TOKEN
            else process.env.GITHUB_COPILOT_TOKEN = previousToken
          }),
        )
        const { processors, session, provider } = yield* boot()
        let executions = 0

        yield* llm.push(
          raw({
            head: [
              responseCreated(),
              responseFunctionCallAdded(),
              responseFunctionCallArgumentsDone(),
              responseCompleted(),
            ],
            passthrough: true,
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "responses args done tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(copilotResponsesRef.providerID, copilotResponsesRef.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: copilotResponsesRef.providerID, modelID: copilotResponsesRef.modelID },
            tools: { noop: true },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "responses args done tool" }],
          tools: {
            noop: tool({
              description: "No-op tool",
              inputSchema: z.object({}),
              execute: async () => {
                executions += 1
                return { output: "ok" }
              },
            }),
          },
        })

        yield* Effect.promise(async () => {
          const end = Date.now() + 500
          while (Date.now() < end) {
            if (executions > 0) return
            await Bun.sleep(10)
          }
        })

        const parts = MessageV2.parts(msg.id)
        const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
        const hits = yield* llm.hits

        expect(hits[0]?.url.pathname).toBe("/v1/responses")
        expect(call).toBeDefined()
        expect(executions).toBe(1)
        expect(call?.state.status).not.toBe("pending")
        expect(call?.state.status).not.toBe("running")
      }),
    { git: true, config: (url) => copilotResponsesProviderCfg(url) },
  ),
)

it.live("test LLM server preserves cached input tokens when converting chat chunks to Responses API events", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const previousToken = process.env.GITHUB_COPILOT_TOKEN
        process.env.GITHUB_COPILOT_TOKEN = "test-copilot-key"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousToken === undefined) delete process.env.GITHUB_COPILOT_TOKEN
            else process.env.GITHUB_COPILOT_TOKEN = previousToken
          }),
        )
        const { processors, session, provider } = yield* boot()

        yield* llm.text("cached response", { usage: { input: 1_000, output: 40, cacheRead: 900 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "responses cache usage")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(copilotResponsesRef.providerID, copilotResponsesRef.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: copilotResponsesRef.providerID, modelID: copilotResponsesRef.modelID },
            tools: {},
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "responses cache usage" }],
          tools: {},
        })

        const stored = MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const hits = yield* llm.hits

        expect(hits[0]?.url.pathname).toBe("/v1/responses")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.tokens.input).toBe(100)
          expect(stored.info.tokens.cache.read).toBe(900)
        }
      }),
    { git: true, config: (url) => copilotResponsesProviderCfg(url) },
  ),
)

// Question tool aborted on cleanup gets a clearer message than the generic
// "Tool execution aborted". The LLM reads part.state.error as the tool result
// and the generic phrasing made models think the user dismissed the question.
// See issue #419.
it.live("session.processor effect tests rewrite aborted question tool error to friendly message", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("question", {
          questions: [
            {
              question: "Pick one",
              header: "Pick",
              options: [
                { label: "A", description: "first" },
                { label: "B", description: "second" },
              ],
            },
          ],
        })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "question abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "question abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Effect.promise(async () => {
          const end = Date.now() + 500
          while (Date.now() < end) {
            const parts = await MessageV2.parts(msg.id)
            if (parts.some((part) => part.type === "tool")) return
            await Bun.sleep(10)
          }
        })
        yield* Fiber.interrupt(run)
        yield* Fiber.await(run)

        const parts = MessageV2.parts(msg.id)
        const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")

        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Question cancelled before the user answered it.")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.metadata?.interruption_phase).toBe("tool_input_generation")
          expect(call.state.metadata?.tool_execution_started).toBe(false)
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* bus.subscribeCallback(Session.Event.Error, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (!evt.properties.error) return
          errs.push(evt.properties.error.name)
          seen.resolve()
        })
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        off()

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
          expect(stored.info.diagnostics?.llm_trace?.flags.aborted).toBe(true)
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("connect timeout writes a safe retry notice and flips session_status idle after retry also fails", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang
        yield* llm.hang
        yield* llm.hang
        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "bad model")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
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
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "bad model" }],
          tools: {},
          connectTimeoutMs: 20,
          streamTimeoutMs: 1_000,
        })

        const stored = MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const parts = MessageV2.parts(msg.id)
        const state = yield* sts.get(chat.id)

        expect(result).toBe("stop")
        expect(yield* llm.calls).toBe(4)
        expect(handle.message.error).toBeUndefined()
        expect(parts.some((part) => part.type === "notice" && part.kind === "safe_retry_failed")).toBe(true)
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error).toBeUndefined()
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ safeRecoveryDelay: FAST_SAFE_RECOVERY_DELAY,
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)
