import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { tool, type ModelMessage } from "ai"
import { Cause, Effect, Exit, Stream } from "effect"
import z from "zod"
import { makeRuntime } from "../../src/effect/run-service"
import { LLM } from "../../src/session/llm"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider"
import { ProviderTransform } from "../../src/provider"
import { ModelsDev } from "../../src/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"
import type { Agent } from "../../src/agent/agent"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { LLMTrace } from "../../src/session/llm-trace"

async function getModel(providerID: ProviderID, modelID: ModelID) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      return yield* provider.getModel(providerID, modelID)
    }),
  )
}

const llm = makeRuntime(LLM.Service, LLM.defaultLayer)

async function drain(input: LLM.StreamInput) {
  return llm.runPromise((svc) => svc.stream(input).pipe(Stream.runDrain))
}

describe("session.llm.hasToolCalls", () => {
  test("returns false for empty messages array", () => {
    expect(LLM.hasToolCalls([])).toBe(false)
  })

  test("returns false for messages with only text content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when messages contain tool-call", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Run a command" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns true when messages contain tool-result", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns false for messages with string content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Hello world",
      },
      {
        role: "assistant",
        content: "Hi there",
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when tool-call is mixed with text content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that command" },
          {
            type: "tool-call",
            toolCallId: "call-456",
            toolName: "read",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })
})

describe("session.llm.buildInvalidToolRepairInput", () => {
  const agent = {
    name: "build",
    mode: "primary",
    permission: [],
    options: {},
  } satisfies Agent.Info
  const user = { tools: {} } as MessageV2.User

  test("omits deferred hint when tool_info is not available", () => {
    const repair = JSON.parse(
      LLM.buildInvalidToolRepairInput(
        {
          agent,
          availableDeferredTools: new Set(["lsp"]),
          permission: [],
          tools: {},
          user,
        },
        "lsp",
        "Unknown tool: lsp",
      ),
    ) as { error: string }

    expect(repair.error).not.toContain('call tool_info with name="lsp"')
  })

  test("includes deferred hint when tool_info can load the deferred tool", () => {
    const repair = JSON.parse(
      LLM.buildInvalidToolRepairInput(
        {
          agent,
          availableDeferredTools: new Set(["lsp"]),
          permission: [],
          tools: { tool_info: {} as never },
          user,
        },
        "lsp",
        "Unknown tool: lsp",
      ),
    ) as { error: string }

    expect(repair.error).toContain('call tool_info with name="lsp"')
  })
})

describe("session.llm.wrapToolsWithLifecycle", () => {
  const toolOptions = { toolCallId: "call-test", messages: [] } as any

  test("reports tool input to the started lifecycle callback", async () => {
    const started: unknown[] = []
    const wrapped = LLM.wrapToolsWithLifecycle(
      {
        probe: tool({
          description: "Probe",
          inputSchema: z.object({ value: z.string() }),
          execute: async () => ({ output: "ok", title: "probe", metadata: {} }),
        }),
      },
      {
        started: async (input) => {
          started.push(input)
        },
      },
    )

    await expect(wrapped.probe.execute?.({ value: "ok" }, toolOptions)).resolves.toMatchObject({
      title: "probe",
      metadata: {},
    })
    expect(started).toEqual([{ tool: "probe", toolCallID: "call-test", input: { value: "ok" } }])
  })

  test("normalizes non-record tool input before lifecycle reporting", async () => {
    const started: unknown[] = []
    const wrapped = LLM.wrapToolsWithLifecycle(
      {
        probe: tool({
          description: "Probe",
          inputSchema: z.any(),
          execute: async () => ({ output: "ok", title: "probe", metadata: {} }),
        }),
      },
      {
        started: async (input) => {
          started.push(input)
        },
      },
    )

    await expect(wrapped.probe.execute?.("raw-input", toolOptions)).resolves.toMatchObject({
      title: "probe",
      metadata: {},
    })
    expect(started).toEqual([{ tool: "probe", toolCallID: "call-test", input: { value: "raw-input" } }])
  })

  test("does not report completed lifecycle errors as tool execution failures", async () => {
    const completedError = new Error("completed callback failed")
    const failed: unknown[] = []
    const wrapped = LLM.wrapToolsWithLifecycle(
      {
        probe: tool({
          description: "Probe",
          inputSchema: z.object({ value: z.string() }),
          execute: async () => ({ output: "ok", title: "probe", metadata: {} }),
        }),
      },
      {
        completed: async () => {
          throw completedError
        },
        failed: async (input) => {
          failed.push(input.error)
        },
      },
    )

    await expect(wrapped.probe.execute?.({ value: "ok" }, toolOptions)).rejects.toThrow(completedError)
    expect(failed).toEqual([])
  })

  test("stringifies non-json tool lifecycle outputs without failing the tool", async () => {
    const completed: string[] = []
    const failed: unknown[] = []
    const wrapped = LLM.wrapToolsWithLifecycle(
      {
        probe: tool({
          description: "Probe",
          inputSchema: z.object({ value: z.string() }),
          execute: async () => ({ output: 1n, title: "probe", metadata: {} }),
        }),
      },
      {
        completed: async (input) => {
          completed.push(input.output.output)
        },
        failed: async (input) => {
          failed.push(input.error)
        },
      },
    )

    await expect(wrapped.probe.execute?.({ value: "ok" }, toolOptions)).resolves.toMatchObject({
      title: "probe",
      metadata: {},
    })
    expect(completed).toEqual(["1"])
    expect(failed).toEqual([])
  })
})

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{
    path: string
    response: Response | ((req: Request, capture: Capture) => Response)
    resolve: (value: Capture) => void
  }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  state.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

function timeout(ms: number) {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function waitStreamingRequest(pathname: string) {
  const request = deferred<Capture>()
  const requestAborted = deferred<void>()
  const responseCanceled = deferred<void>()
  const encoder = new TextEncoder()

  state.queue.push({
    path: pathname,
    resolve: request.resolve,
    response(req: Request) {
      req.signal.addEventListener("abort", () => requestAborted.resolve(), { once: true })

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  `data: ${JSON.stringify({
                    id: "chatcmpl-abort",
                    object: "chat.completion.chunk",
                    choices: [{ delta: { role: "assistant" } }],
                  })}`,
                ].join("\n\n") + "\n\n",
              ),
            )
          },
          cancel() {
            responseCanceled.resolve()
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      )
    },
  })

  return {
    request: request.promise,
    requestAborted: requestAborted.promise,
    responseCanceled: responseCanceled.promise,
  }
}

function waitSilentStreamingRequest(pathname: string) {
  const request = deferred<Capture>()
  const requestAborted = deferred<void>()
  const responseCanceled = deferred<void>()

  state.queue.push({
    path: pathname,
    resolve: request.resolve,
    response(req: Request) {
      req.signal.addEventListener("abort", () => requestAborted.resolve(), { once: true })

      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            responseCanceled.resolve()
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      )
    },
  })

  return {
    request: request.promise,
    requestAborted: requestAborted.promise,
    responseCanceled: responseCanceled.promise,
  }
}

function waitStartOnlyStreamingRequest(pathname: string) {
  const request = deferred<Capture>()
  const requestAborted = deferred<void>()
  const responseCanceled = deferred<void>()
  const encoder = new TextEncoder()
  let interval: Timer | undefined

  state.queue.push({
    path: pathname,
    resolve: request.resolve,
    response(req: Request) {
      req.signal.addEventListener("abort", () => requestAborted.resolve(), { once: true })

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            interval = setInterval(() => {
              controller.enqueue(
                encoder.encode(
                  [
                    `data: ${JSON.stringify({
                      id: "chatcmpl-start-only",
                      object: "chat.completion.chunk",
                      choices: [{ delta: { role: "assistant" } }],
                    })}`,
                  ].join("\n\n") + "\n\n",
                ),
              )
            }, 5)
          },
          cancel() {
            if (interval) clearInterval(interval)
            responseCanceled.resolve()
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      )
    },
  })

  return {
    request: request.promise,
    requestAborted: requestAborted.promise,
    responseCanceled: responseCanceled.promise,
  }
}

function waitProgressThenSilentStreamingRequest(pathname: string) {
  const request = deferred<Capture>()
  const requestAborted = deferred<void>()
  const responseCanceled = deferred<void>()
  const encoder = new TextEncoder()

  state.queue.push({
    path: pathname,
    resolve: request.resolve,
    response(req: Request) {
      req.signal.addEventListener("abort", () => requestAborted.resolve(), { once: true })

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  `data: ${JSON.stringify({
                    id: "chatcmpl-progress-then-silent",
                    object: "chat.completion.chunk",
                    choices: [{ delta: { role: "assistant" } }],
                  })}`,
                  `data: ${JSON.stringify({
                    id: "chatcmpl-progress-then-silent",
                    object: "chat.completion.chunk",
                    choices: [{ delta: { content: "Hello" } }],
                  })}`,
                ].join("\n\n") + "\n\n",
              ),
            )
          },
          cancel() {
            responseCanceled.resolve()
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      )
    },
  })

  return {
    request: request.promise,
    requestAborted: requestAborted.promise,
    responseCanceled: responseCanceled.promise,
  }
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = state.queue.shift()
      if (!next) {
        return new Response("unexpected request", { status: 500 })
      }

      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })

      if (!url.pathname.endsWith(next.path)) {
        return new Response("not found", { status: 404 })
      }

      return typeof next.response === "function"
        ? next.response(req, { url, headers: req.headers, body })
        : next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
})

afterAll(() => {
  void state.server?.stop()
})

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

async function loadFixture(providerID: string, modelID: string) {
  const fixturePath = path.join(import.meta.dir, "../tool/fixtures/models-api.json")
  const data = await Filesystem.readJson<Record<string, ModelsDev.Provider>>(fixturePath)
  const provider = data[providerID]
  if (!provider) {
    throw new Error(`Missing provider in fixture: ${providerID}`)
  }
  const model = provider.models[modelID]
  if (!model) {
    throw new Error(`Missing model in fixture: ${modelID}`)
  }
  return { provider, model }
}

function createEventStream(chunks: unknown[], includeDone = false) {
  const lines = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`)
  if (includeDone) {
    lines.push("data: [DONE]")
  }
  const payload = lines.join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createEventResponse(chunks: unknown[], includeDone = false) {
  return new Response(createEventStream(chunks, includeDone), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

describe("session.llm.stream", () => {
  test("sends temperature, tokens, and reasoning options for openai-compatible models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "vivgrid"
    const modelID = "gemini-3.1-pro-preview"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-1")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-1"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id, variant: "high" },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = await request
        const body = capture.body
        const headers = capture.headers
        const url = capture.url

        expect(url.pathname.startsWith("/v1/")).toBe(true)
        expect(url.pathname.endsWith("/chat/completions")).toBe(true)
        expect(headers.get("Authorization")).toBe("Bearer test-key")

        expect(body.model).toBe(resolved.api.id)
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.8)
        expect(body.stream).toBe(true)

        const maxTokens = (body.max_tokens as number | undefined) ?? (body.max_output_tokens as number | undefined)
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)

        const reasoning = (body.reasoningEffort as string | undefined) ?? (body.reasoning_effort as string | undefined)
        expect(reasoning).toBe("high")
      },
    })
  })

  test("service stream cancellation cancels provider response body promptly", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model
    const pending = waitStreamingRequest("/chat/completions")

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-service-abort")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("user-service-abort"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const ctrl = new AbortController()
        const run = llm.runPromiseExit(
          (svc) =>
            svc
              .stream({
                user,
                sessionID,
                model: resolved,
                agent,
                system: ["You are a helpful assistant."],
                messages: [{ role: "user", content: "Hello" }],
                tools: {},
              })
              .pipe(Stream.runDrain),
          { signal: ctrl.signal },
        )

        await pending.request
        ctrl.abort()

        await Promise.race([pending.responseCanceled, timeout(500)])
        const exit = await run
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        }
        await Promise.race([pending.requestAborted, timeout(500)]).catch(() => undefined)
      },
    })
  })

  test("silent stream timeout cancels provider response body promptly", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model
    const pending = waitProgressThenSilentStreamingRequest("/chat/completions")

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-silent-timeout")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("user-silent-timeout"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User
        const trace = LLMTrace.createRecorder({
          traceID: MessageID.make("trace-silent-timeout"),
          sessionID,
          messageID: MessageID.make("assistant-silent-timeout"),
          providerID,
          modelID: resolved.id,
          agent: agent.name,
          createdAt: Date.now(),
        })

        const exit = await llm.runPromiseExit((svc) =>
          svc
            .stream({
              user,
              sessionID,
              model: resolved,
              agent,
              system: ["You are a helpful assistant."],
              messages: [{ role: "user", content: "Hello" }],
              tools: {},
              connectTimeoutMs: 1_000,
              streamTimeoutMs: 20,
              trace,
            })
            .pipe(Stream.runDrain),
        )

        await Promise.race([pending.responseCanceled, timeout(500)])
        await Promise.race([pending.requestAborted, timeout(500)]).catch(() => undefined)
        await pending.request
        expect(Exit.isFailure(exit)).toBe(false)
        const summary = trace.finalize({ completedAt: Date.now(), storedParts: [] })
        expect(summary.stream?.watchdog).toMatchObject({
          fired: true,
          fired_phase: "silent_stream",
          provider_progressed: true,
        })
        expect(summary.stream?.error).toBeUndefined()
      },
    })
  })

  test("connect timeout produces stream failure not success drain", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model
    const pending = waitSilentStreamingRequest("/chat/completions")

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-connect-timeout-failure")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("user-connect-timeout-failure"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User
        const trace = LLMTrace.createRecorder({
          traceID: MessageID.make("trace-connect-timeout"),
          sessionID,
          messageID: MessageID.make("assistant-connect-timeout"),
          providerID,
          modelID: resolved.id,
          agent: agent.name,
          createdAt: Date.now(),
        })

        const exit = await llm.runPromiseExit((svc) =>
          svc
            .stream({
              user,
              sessionID,
              model: resolved,
              agent,
              system: ["You are a helpful assistant."],
              messages: [{ role: "user", content: "Hello" }],
              tools: {},
              connectTimeoutMs: 20,
              streamTimeoutMs: 1_000,
              trace,
            })
            .pipe(Stream.runDrain),
        )

        await Promise.race([pending.responseCanceled, timeout(500)])
        await Promise.race([pending.requestAborted, timeout(500)]).catch(() => undefined)
        await pending.request
        expect(Exit.isFailure(exit)).toBe(true)
        const summary = trace.finalize({ completedAt: Date.now(), storedParts: [], streamError: true })
        expect(summary.stream?.watchdog).toMatchObject({
          fired: true,
          fired_phase: "connect",
          provider_progressed: false,
        })
        expect(summary.stream?.error).toMatchObject({
          boundary: "watchdog",
          confidence: "high",
          evidence: expect.arrayContaining(["watchdog_fired", "watchdog_error"]),
        })
      },
    })
  })

  test("start events do not reset connect timer and timeout produces stream failure", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model
    const pending = waitStartOnlyStreamingRequest("/chat/completions")

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-start-only-connect-timeout")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("user-start-only-connect-timeout"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const exit = await Promise.race([
          llm.runPromiseExit((svc) =>
            svc
              .stream({
                user,
                sessionID,
                model: resolved,
                agent,
                system: ["You are a helpful assistant."],
                messages: [{ role: "user", content: "Hello" }],
                tools: {},
                connectTimeoutMs: 20,
                streamTimeoutMs: 1_000,
              })
              .pipe(Stream.runDrain),
          ),
          timeout(500),
        ])

        await Promise.race([pending.responseCanceled, timeout(500)])
        await Promise.race([pending.requestAborted, timeout(500)]).catch(() => undefined)
        await pending.request
        expect(Exit.isFailure(exit)).toBe(true)
      },
    })
  })

  test("keeps tools enabled by prompt permissions", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "question", pattern: "*", action: "deny" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          tools: { question: true },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          permission: [{ permission: "question", pattern: "*", action: "allow" }],
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {
            question: tool({
              description: "Ask a question",
              inputSchema: z.object({}),
              execute: async () => ({ output: "" }),
            }),
          },
        })

        const capture = await request
        const tools = capture.body.tools as Array<{ function?: { name?: string } }> | undefined
        expect(tools?.some((item) => item.function?.name === "question")).toBe(true)
      },
    })
  })

  test("keeps noop compatibility tool active for LiteLLM tool-call history", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "test-litellm"
    const source = await loadFixture("alibaba", "qwen-plus")
    const model = source.model
    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                name: "Test LiteLLM",
                env: ["TEST_LITELLM_API_KEY"],
                npm: "@ai-sdk/openai-compatible",
                api: `${server.url.origin}/v1`,
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-litellm-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-noop-tool")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("user-noop-tool"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const ctrl = new AbortController()
        const run = llm.runPromiseExit(
          (svc) =>
            svc
              .stream({
                user,
                sessionID,
                model: resolved,
                agent,
                system: ["You are a helpful assistant."],
                messages: [
                  { role: "user", content: "Read a file" },
                  {
                    role: "assistant",
                    content: [{ type: "tool-call", toolCallId: "call-1", toolName: "read", input: {} }],
                  },
                  {
                    role: "tool",
                    content: [
                      {
                        type: "tool-result",
                        toolCallId: "call-1",
                        toolName: "read",
                        output: { type: "text", value: "done" },
                      },
                    ],
                  },
                ] as ModelMessage[],
                tools: {},
              })
              .pipe(Stream.runDrain),
          { signal: ctrl.signal },
        )

        const capture = await Promise.race([request, timeout(500)])
        const tools = capture.body.tools as Array<{ function?: { name?: string } }> | undefined
        expect(tools?.some((item) => item.function?.name === "_noop")).toBe(true)
        ctrl.abort()
        await run
      },
    })
  })

  test("sends tools in deterministic alphabetical order", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model
    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-tool-order")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-tool-order"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {
            zebra: tool({ description: "zebra", inputSchema: z.object({}), execute: async () => ({ output: "" }) }),
            alpha: tool({ description: "alpha", inputSchema: z.object({}), execute: async () => ({ output: "" }) }),
            middle: tool({ description: "middle", inputSchema: z.object({}), execute: async () => ({ output: "" }) }),
          },
        })

        const capture = await request
        const tools = capture.body.tools as Array<{ function?: { name?: string } }> | undefined
        expect(tools?.map((item) => item.function?.name)).toEqual(["alpha", "middle", "zebra"])
      },
    })
  })

  test("sends responses API payload for OpenAI models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model

    const responseChunks = [
      {
        type: "response.created",
        response: {
          id: "resp-1",
          created_at: Math.floor(Date.now() / 1000),
          model: model.id,
          service_tier: null,
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-1",
        delta: "Hello",
        logprobs: null,
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(responseChunks, true))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.openai, ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-2")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-2"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("openai"), modelID: resolved.id, variant: "high" },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.stream).toBe(true)
        expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")

        const maxTokens = body.max_output_tokens as number | undefined
        expect(maxTokens).toBe(undefined) // match codex cli behavior
      },
    })
  })

  test("accepts user image attachments as data URLs for OpenAI models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model
    const chunks = [
      {
        type: "response.created",
        response: {
          id: "resp-data-url",
          created_at: Math.floor(Date.now() / 1000),
          model: model.id,
          service_tier: null,
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-data-url",
        delta: "Looks good",
        logprobs: null,
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(chunks, true))
    const image = `data:image/png;base64,${Buffer.from(
      await Bun.file(path.join(import.meta.dir, "../tool/fixtures/large-image.png")).arrayBuffer(),
    ).toString("base64")}`

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.openai, ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-data-url")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-data-url"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("openai"), modelID: resolved.id },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this image" },
                {
                  type: "file",
                  mediaType: "image/png",
                  filename: "large-image.png",
                  data: image,
                },
              ],
            },
          ] as ModelMessage[],
          tools: {},
        })

        const capture = await request
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
      },
    })
  })

  test("sends messages API payload for Anthropic Compatible models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "minimax"
    const modelID = "MiniMax-M2.5"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const chunks = [
      {
        type: "message_start",
        message: {
          id: "msg-1",
          model: model.id,
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      { type: "message_stop" },
    ]
    const request = waitRequest("/messages", createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-anthropic-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-3")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.9,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-3"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("minimax"), modelID: ModelID.make("MiniMax-M2.5") },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.max_tokens).toBe(ProviderTransform.maxOutputTokens(resolved))
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.9)
      },
    })
  })

  test("preserves Anthropic assistant tool_use order when text trails tool calls", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("anthropic", "claude-opus-4-6")
    const model = source.model
    const chunks = [
      {
        type: "message_start",
        message: {
          id: "msg-tool-order",
          model: model.id,
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      { type: "message_stop" },
    ]
    const request = waitRequest("/messages", createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["anthropic"],
            provider: {
              anthropic: {
                name: "Anthropic",
                env: ["ANTHROPIC_API_KEY"],
                npm: "@ai-sdk/anthropic",
                api: "https://api.anthropic.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-anthropic-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make("anthropic"), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-anthropic-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("user-anthropic-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("anthropic"), modelID: resolved.id, variant: "max" },
        } satisfies MessageV2.User

        const input = [
          {
            info: {
              id: "msg_user",
              sessionID,
              role: "user",
              time: { created: 1 },
              agent: "gentleman",
              model: { providerID: "anthropic", modelID: "claude-opus-4-6", variant: "max" },
            },
            parts: [
              {
                id: "p_user",
                sessionID,
                messageID: "msg_user",
                type: "text",
                text: "Can you check whether there are any PDF files in my home directory?",
              },
            ],
          },
          {
            info: {
              id: "msg_call",
              sessionID,
              parentID: "msg_user",
              role: "assistant",
              mode: "gentleman",
              agent: "gentleman",
              variant: "max",
              path: { cwd: "/root", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: "claude-opus-4-6",
              providerID: "anthropic",
              time: { created: 2, completed: 3 },
              finish: "tool-calls",
            },
            parts: [
              {
                id: "p_step",
                sessionID,
                messageID: "msg_call",
                type: "step-start",
              },
              {
                id: "p_read",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "read",
                callID: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                state: {
                  status: "completed",
                  input: { filePath: "/root" },
                  output: "<path>/root</path>",
                  metadata: {},
                  title: "root",
                  time: { start: 10, end: 11 },
                },
              },
              {
                id: "p_glob",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "glob",
                callID: "toolu_01APxrADs7VozN8uWzw9WwHr",
                state: {
                  status: "completed",
                  input: { pattern: "**/*.pdf", path: "/root" },
                  output: "No files found",
                  metadata: {},
                  title: "root",
                  time: { start: 12, end: 13 },
                },
              },
              {
                id: "p_text",
                sessionID,
                messageID: "msg_call",
                type: "text",
                text: "I checked your home directory and looked for PDF files.",
                time: { start: 14, end: 15 },
              },
            ],
          },
        ] as any[]

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: await MessageV2.toModelMessages(input as any, resolved),
          tools: {
            read: tool({
              description: "Stub read tool",
              inputSchema: z.object({
                filePath: z.string(),
              }),
              execute: async () => ({ output: "stub" }),
            }),
            glob: tool({
              description: "Stub glob tool",
              inputSchema: z.object({
                pattern: z.string(),
                path: z.string().optional(),
              }),
              execute: async () => ({ output: "stub" }),
            }),
          },
        })

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.messages).toStrictEqual([
          {
            role: "user",
            content: [{ type: "text", text: "Can you check whether there are any PDF files in my home directory?" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                name: "read",
                input: { filePath: "/root" },
              },
              {
                type: "tool_use",
                id: "toolu_01APxrADs7VozN8uWzw9WwHr",
                name: "glob",
                input: { pattern: "**/*.pdf", path: "/root" },
              },
              {
                type: "text",
                text: "I checked your home directory and looked for PDF files.",
                cache_control: {
                  type: "ephemeral",
                },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                content: "<path>/root</path>",
              },
              {
                type: "tool_result",
                tool_use_id: "toolu_01APxrADs7VozN8uWzw9WwHr",
                content: "No files found",
                cache_control: {
                  type: "ephemeral",
                },
              },
            ],
          },
        ])
      },
    })
  })

  test("sends Google API payload for Gemini models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "google"
    const modelID = "gemini-2.5-flash"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model
    const pathSuffix = `/v1beta/models/${model.id}:streamGenerateContent`

    const chunks = [
      {
        candidates: [
          {
            content: {
              parts: [{ text: "Hello" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      },
    ]
    const request = waitRequest(pathSuffix, createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-google-key",
                  baseURL: `${server.url.origin}/v1beta`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-4")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.3,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-4"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = await request
        const body = capture.body
        const config = body.generationConfig as
          | { temperature?: number; topP?: number; maxOutputTokens?: number }
          | undefined

        expect(capture.url.pathname).toBe(pathSuffix)
        expect(config?.temperature).toBe(0.3)
        expect(config?.topP).toBe(0.8)
        expect(config?.maxOutputTokens).toBe(ProviderTransform.maxOutputTokens(resolved))
      },
    })
  })
})
