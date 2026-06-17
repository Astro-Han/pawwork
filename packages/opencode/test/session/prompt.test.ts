import fs from "fs/promises"
import path from "path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { NamedError } from "@opencode-ai/util/error"
import { fileURLToPath, pathToFileURL } from "url"
import { Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Instance } from "../../src/project/instance"
import { Permission } from "../../src/permission"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function chat(text: string) {
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
    start(ctrl) {
      ctrl.enqueue(encoder.encode(payload))
      ctrl.close()
    },
  })
}

function hanging(ready: () => void) {
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setTimeout> | undefined
  const first = `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    choices: [{ delta: { role: "assistant" } }],
  })}\n\n`
  const rest =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: "late" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(first))
      ready()
      timer = setTimeout(() => {
        ctrl.enqueue(encoder.encode(rest))
        ctrl.close()
      }, 10000)
    },
    cancel() {
      if (timer) clearTimeout(timer)
    },
  })
}

describe("session.prompt missing file", () => {
  test("does not fail the prompt when a file part is missing", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({})

            const missing = path.join(tmp.path, "does-not-exist.ts")
            const msg = yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              noReply: true,
              parts: [
                { type: "text", text: "please review @does-not-exist.ts" },
                {
                  type: "file",
                  mime: "text/plain",
                  url: `file://${missing}`,
                  filename: "does-not-exist.ts",
                },
              ],
            })

            if (msg.info.role !== "user") throw new Error("expected user message")

            const hasFailure = msg.parts.some(
              (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
            )
            expect(hasFailure).toBe(true)
            expect(msg.parts.some((part) => part.type === "file" && part.url === `file://${missing}`)).toBe(true)

            yield* sessions.remove(session.id)
          }),
        ),
    })
  })

  test("keeps Office file path parts without calling Read", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "report.docx"), Uint8Array.of(0, 1, 2, 3))
      },
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({})
            const file = path.join(tmp.path, "report.docx")
            const fileUrl = pathToFileURL(file).href

            const msg = yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              noReply: true,
              parts: [
                { type: "text", text: "summarize this document" },
                {
                  type: "file",
                  mime: "text/plain",
                  url: fileUrl,
                  filename: "report.docx",
                },
              ],
            })

            if (msg.info.role !== "user") throw new Error("expected user message")

            expect(
              msg.parts.some(
                (part) =>
                  part.type === "text" &&
                  part.synthetic &&
                  part.text.startsWith("Called the Read tool with the following input:"),
              ),
            ).toBe(false)
            expect(msg.parts.some((part) => part.type === "file" && part.url === fileUrl)).toBe(true)
            expect(
              msg.parts.some(
                (part) =>
                  part.type === "text" &&
                  part.synthetic &&
                  part.text === `Attached local file by path: ${file}`,
              ),
            ).toBe(true)

            yield* sessions.remove(session.id)
          }),
        ),
    })
  })

  test("keeps stored part order stable when file resolution is async", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({})

            const missing = path.join(tmp.path, "still-missing.ts")
            const msg = yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              noReply: true,
              parts: [
                {
                  type: "file",
                  mime: "text/plain",
                  url: `file://${missing}`,
                  filename: "still-missing.ts",
                },
                { type: "text", text: "after-file" },
              ],
            })

            if (msg.info.role !== "user") throw new Error("expected user message")

            const stored = MessageV2.get({
              sessionID: session.id,
              messageID: msg.info.id,
            })
            const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

            expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
            expect(text[1]?.includes("Read tool failed to read")).toBe(true)
            expect(text[2]).toBe("after-file")

            yield* sessions.remove(session.id)
          }),
        ),
    })
  })
})

describe("session.prompt special characters", () => {
  test("handles filenames with # character", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "file#name.txt"), "special content\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({})
            const template = "Read @file#name.txt"
            const parts = yield* prompt.resolvePromptParts(template)
            const fileParts = parts.filter((part) => part.type === "file")

            expect(fileParts.length).toBe(1)
            expect(fileParts[0].filename).toBe("file#name.txt")
            expect(fileParts[0].url).toContain("%23")

            const decodedPath = fileURLToPath(fileParts[0].url)
            expect(decodedPath).toBe(path.join(tmp.path, "file#name.txt"))

            const message = yield* prompt.prompt({
              sessionID: session.id,
              parts,
              noReply: true,
            })
            const stored = MessageV2.get({ sessionID: session.id, messageID: message.info.id })
            const textParts = stored.parts.filter((part) => part.type === "text")
            const hasContent = textParts.some((part) => part.text.includes("special content"))
            expect(hasContent).toBe(true)

            yield* sessions.remove(session.id)
          }),
        ),
    })
  })
})

describe("session.prompt regression", () => {
  test("does not loop empty assistant turns for a simple reply", async () => {
    let calls = 0
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 })
        }
        calls++
        return new Response(chat("packages/opencode/src/session/processor.ts"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.url.origin}/v1`,
                  },
                },
              },
              agent: {
                build: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const prompt = yield* SessionPrompt.Service
              const sessions = yield* Session.Service
              const session = yield* sessions.create({ title: "Prompt regression" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Where is SessionProcessor?" }],
              })

              expect(result.info.role).toBe("assistant")
              expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

              const msgs = yield* sessions.messages({ sessionID: session.id })
              expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
              expect(calls).toBe(1)
            }),
          ),
      })
    } finally {
      void server.stop(true)
    }
  })

  test("records aborted errors when prompt is cancelled mid-stream", async () => {
    const ready = defer<void>()
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 })
        }
        return new Response(
          hanging(() => ready.resolve()),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          },
        )
      },
    })

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.url.origin}/v1`,
                  },
                },
              },
              agent: {
                build: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const prompt = yield* SessionPrompt.Service
              const sessions = yield* Session.Service
              const session = yield* sessions.create({ title: "Prompt cancel regression" })
              const task = Effect.runPromise(
                prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "Cancel me" }],
                }),
              )

              yield* Effect.promise(() => ready.promise)
              yield* prompt.cancel(session.id)

              const result = yield* Effect.promise(() =>
                Promise.race([
                  task,
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error("timed out waiting for cancel")), 1000),
                  ),
                ]),
              )

              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") {
                expect(result.info.error?.name).toBe("MessageAbortedError")
              }

              const msgs = yield* sessions.messages({ sessionID: session.id })
              const last = msgs.findLast((msg) => msg.info.role === "assistant")
              expect(last?.info.role).toBe("assistant")
              if (last?.info.role === "assistant") {
                expect(last.info.error?.name).toBe("MessageAbortedError")
              }
            }),
          ),
      })
    } finally {
      void server.stop(true)
    }
  })

  test("loop exits without an LLM request for an interrupted orphan tool call", async () => {
    let calls = 0
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 })
        }
        calls++
        return new Response(chat("should never be requested"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.url.origin}/v1`,
                  },
                },
              },
              agent: {
                build: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const prompt = yield* SessionPrompt.Service
              const sessions = yield* Session.Service
              const session = yield* sessions.create({ title: "Interrupted orphan" })
              const model = { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") }

              // A finished assistant turn (finish "stop") that still carries a tool part the
              // interrupt cleanup marked status:"error" + metadata.interrupted — an orphan, not
              // pending work. With no newer user message the loop must exit, not prefill the LLM.
              const user = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "user",
                sessionID: session.id,
                agent: "build",
                model,
                time: { created: Date.now() },
              })
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: user.id,
                sessionID: session.id,
                type: "text",
                text: "do something",
              })

              const assistant: MessageV2.Assistant = {
                id: MessageID.ascending(),
                role: "assistant",
                sessionID: session.id,
                parentID: user.id,
                mode: "build",
                agent: "build",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: model.modelID,
                providerID: model.providerID,
                time: { created: Date.now() },
                finish: "stop",
              }
              yield* sessions.updateMessage(assistant)
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: assistant.id,
                sessionID: session.id,
                type: "tool",
                callID: "interrupted-call",
                tool: "edit",
                state: {
                  status: "error",
                  input: {},
                  error: "Tool execution aborted",
                  metadata: { interrupted: true },
                  time: { start: 1, end: 2 },
                },
              })

              const result = yield* prompt.loop({ sessionID: session.id })
              expect(result.info.id).toBe(assistant.id)
              expect(calls).toBe(0)
            }),
          ),
      })
    } finally {
      void server.stop(true)
    }
  })

  test("loop still continues when an interrupted orphan coexists with a real tool call", async () => {
    let calls = 0
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 })
        }
        calls++
        return new Response(chat("continued"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.url.origin}/v1`,
                  },
                },
              },
              agent: {
                build: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const prompt = yield* SessionPrompt.Service
              const sessions = yield* Session.Service
              const session = yield* sessions.create({ title: "Orphan plus real tool" })
              const model = { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") }

              const user = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "user",
                sessionID: session.id,
                agent: "build",
                model,
                time: { created: Date.now() },
              })
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: user.id,
                sessionID: session.id,
                type: "text",
                text: "do something",
              })

              const assistant: MessageV2.Assistant = {
                id: MessageID.ascending(),
                role: "assistant",
                sessionID: session.id,
                parentID: user.id,
                mode: "build",
                agent: "build",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: model.modelID,
                providerID: model.providerID,
                time: { created: Date.now() },
                finish: "stop",
              }
              yield* sessions.updateMessage(assistant)
              // An interrupted orphan...
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: assistant.id,
                sessionID: session.id,
                type: "tool",
                callID: "interrupted-call",
                tool: "edit",
                state: {
                  status: "error",
                  input: {},
                  error: "Tool execution aborted",
                  metadata: { interrupted: true },
                  time: { start: 1, end: 2 },
                },
              })
              // ...alongside a real, completed tool call. The real call must keep the
              // loop alive, so the orphan exclusion must not suppress continuation.
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: assistant.id,
                sessionID: session.id,
                type: "tool",
                callID: "real-call",
                tool: "bash",
                state: {
                  status: "completed",
                  input: {},
                  output: "ok",
                  title: "done",
                  metadata: {},
                  time: { start: 1, end: 2 },
                },
              })

              yield* prompt.loop({ sessionID: session.id })
              expect(calls).toBeGreaterThan(0)
            }),
          ),
      })
    } finally {
      void server.stop(true)
    }
  })
})

describe("session.prompt agent variant", () => {
  test("applies agent variant only when using agent model", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
              variant: "xhigh",
            },
          },
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const prompt = yield* SessionPrompt.Service
              const sessions = yield* Session.Service
              const session = yield* sessions.create({})

              const other = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
                noReply: true,
                parts: [{ type: "text", text: "hello" }],
              })
              if (other.info.role !== "user") throw new Error("expected user message")
              expect(other.info.model.variant).toBeUndefined()

              const match = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                noReply: true,
                parts: [{ type: "text", text: "hello again" }],
              })
              if (match.info.role !== "user") throw new Error("expected user message")
              expect(match.info.model).toEqual({
                providerID: ProviderID.make("openai"),
                modelID: ModelID.make("gpt-5.2"),
                variant: "xhigh",
              })
              expect(match.info.model.variant).toBe("xhigh")

              const override = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                noReply: true,
                variant: "high",
                parts: [{ type: "text", text: "hello third" }],
              })
              if (override.info.role !== "user") throw new Error("expected user message")
              expect(override.info.model.variant).toBe("high")

              yield* sessions.remove(session.id)
            }),
          ),
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })
})

describe("session.agent-resolution", () => {
  test("unknown agent throws typed error", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({})
            const err = yield* Effect.promise(() =>
              Effect.runPromise(
                prompt.prompt({
                  sessionID: session.id,
                  agent: "nonexistent-agent-xyz",
                  noReply: true,
                  parts: [{ type: "text", text: "hello" }],
                }),
              ).then(
                () => undefined,
                (e) => e,
              ),
            )
            expect(err).toBeDefined()
            expect(err).not.toBeInstanceOf(TypeError)
            expect(NamedError.Unknown.isInstance(err)).toBe(true)
            if (NamedError.Unknown.isInstance(err)) {
              expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
            }
          }),
        ),
    })
  }, 30000)

  test("unknown agent error includes available agent names", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({})
            const err = yield* Effect.promise(() =>
              Effect.runPromise(
                prompt.prompt({
                  sessionID: session.id,
                  agent: "nonexistent-agent-xyz",
                  noReply: true,
                  parts: [{ type: "text", text: "hello" }],
                }),
              ).then(
                () => undefined,
                (e) => e,
              ),
            )
            expect(NamedError.Unknown.isInstance(err)).toBe(true)
            if (NamedError.Unknown.isInstance(err)) {
              expect(err.data.message).toContain("build")
            }
          }),
        ),
    })
  }, 30000)

  test("unknown command throws typed error with available names", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({})
            const err = yield* Effect.promise(() =>
              Effect.runPromise(
                prompt.command({
                  sessionID: session.id,
                  command: "nonexistent-command-xyz",
                  arguments: "",
                }),
              ).then(
                () => undefined,
                (e) => e,
              ),
            )
            expect(err).toBeDefined()
            expect(err).not.toBeInstanceOf(TypeError)
            expect(NamedError.Unknown.isInstance(err)).toBe(true)
            if (NamedError.Unknown.isInstance(err)) {
              expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
              expect(err.data.message).toContain("init")
            }
          }),
        ),
    })
  }, 30000)

  test("$ARGUMENTS command expansion preserves dollar patterns literally", async () => {
    let requestText = ""
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 })
        }

        const body = (await req.json()) as {
          messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
        }
        requestText = body.messages
          .filter((message) => message.role === "user")
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content
                  .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
                  .join("\n"),
          )
          .join("\n")

        return new Response(chat("ok"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.url.origin}/v1`,
                  },
                },
              },
              agent: {
                build: {
                  model: "alibaba/qwen-plus",
                },
              },
              command: {
                literal: {
                  template: "Keep $ARGUMENTS",
                  agent: "build",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          await SessionPrompt.command({
            sessionID: session.id,
            command: "literal",
            arguments: "$$PID $& $1",
          })
        },
      })

      expect(requestText).toContain("Keep $$PID $& $1")
    } finally {
      server.stop(true)
    }
  }, 30000)

  test("threads locale into system prompts for prompt, resumed loop, and command requests", async () => {
    const systems: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 })
        }

        const body = (await req.json()) as {
          messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
        }

        const text = body.messages
          .filter((message) => message.role === "system")
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content
                  .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
                  .join("\n"),
          )
          .join("\n")

        systems.push(text)
        return new Response(chat("ok"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.url.origin}/v1`,
                  },
                },
              },
              agent: {
                build: {
                  model: "alibaba/qwen-plus",
                },
              },
              command: {
                summarize: {
                  template: "Summarize the latest user request.",
                  agent: "build",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})

          await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "hello" }],
            locale: "zh-Hans",
            noReply: true,
          })

          await SessionPrompt.loop({
            sessionID: session.id,
          })

          await SessionPrompt.command({
            sessionID: session.id,
            command: "summarize",
            arguments: "",
            locale: "pt-BR",
          })

          expect(systems.some((text) => text.includes("User locale: zh-Hans"))).toBe(true)
          expect(systems.some((text) => text.includes("User locale: pt-BR"))).toBe(true)
        },
      })
    } finally {
      server.stop(true)
    }
  }, 30000)
})

describe("session.prompt inline skill parts", () => {
  test("resolves a skill part to a chip plus synthetic template text, position-independent", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: { build: { model: "openai/gpt-5.2" } },
        skills: { paths: ["skills"] },
      },
      async init(dir) {
        const skillDir = path.join(dir, "skills", "summarize")
        await fs.mkdir(skillDir, { recursive: true })
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          ["---", "name: summarize", "description: Summarize the thread", "---", "", "Summarize the latest user request."].join(
            "\n",
          ),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({})

            // Skill chip sits AFTER the prose — position-independent activation.
            const msg = yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              noReply: true,
              parts: [
                { type: "text", text: "please" },
                { type: "skill", name: "summarize" },
              ],
            })
            if (msg.info.role !== "user") throw new Error("expected user message")

            // The structured chip part is persisted (renders the chip; not sent to the model).
            const skill = msg.parts.find((part) => part.type === "skill")
            expect(skill).toBeDefined()
            if (skill?.type === "skill") expect(skill.name).toBe("summarize")

            // The expanded template is injected as a synthetic, model-visible text part.
            expect(
              msg.parts.some(
                (part) =>
                  part.type === "text" && part.synthetic && part.text === "Summarize the latest user request.",
              ),
            ).toBe(true)

            // The user's own prose survives as a normal (non-synthetic) text part.
            expect(
              msg.parts.some((part) => part.type === "text" && !part.synthetic && part.text === "please"),
            ).toBe(true)

            yield* sessions.remove(session.id)
          }),
        ),
    })
  }, 30000)

  test("keeps the chip but injects nothing when the skill name is unknown", async () => {
    await using tmp = await tmpdir({
      config: { agent: { build: { model: "openai/gpt-5.2" } } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({})

            const msg = yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              noReply: true,
              parts: [
                { type: "text", text: "hi" },
                { type: "skill", name: "does-not-exist" },
              ],
            })
            if (msg.info.role !== "user") throw new Error("expected user message")

            // Unknown skill: the chip is preserved (so the bubble still renders) ...
            expect(msg.parts.some((part) => part.type === "skill" && part.name === "does-not-exist")).toBe(true)
            // ... but no synthetic template text is injected.
            expect(msg.parts.some((part) => part.type === "text" && part.synthetic)).toBe(false)

            yield* sessions.remove(session.id)
          }),
        ),
    })
  }, 30000)

  test("does not expand a non-skill command delivered as a SkillPart", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: { build: { model: "openai/gpt-5.2" } },
        command: { brainstorm: { template: "Start a brainstorming session." } },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({})

            const msg = yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              noReply: true,
              parts: [
                { type: "text", text: "go" },
                { type: "skill", name: "brainstorm" },
              ],
            })
            if (msg.info.role !== "user") throw new Error("expected user message")

            expect(msg.parts.some((part) => part.type === "skill" && part.name === "brainstorm")).toBe(true)
            expect(msg.parts.some((part) => part.type === "text" && part.synthetic)).toBe(false)

            yield* sessions.remove(session.id)
          }),
        ),
    })
  }, 30000)
})

// #26597: the prompt rebuilds session.permission from the boolean tools map, which can only
// regenerate whole-tool ("*") rules for the keys it lists. For an agent-tool subagent it must
// carry forward the caller's inherited rules the map can't regenerate — scoped denies,
// external_directory rules, and whole-tool denies for keys the map doesn't list (the wildcard
// "*", MCP/custom tools) — otherwise a caller denied e.g. edit on one path, an external dir, or a
// whole tool regains it through the child. Whole-tool denies for keys the map DOES list are
// regenerated from the map instead, so the ruleset doesn't accumulate across turns.
describe("session.prompt subagent permission rebuild (#26597)", () => {
  test("carries scoped denies and external_directory forward for an agent-tool subagent", async () => {
    await using tmp = await tmpdir({
      config: { agent: { build: { model: "openai/gpt-5.2" } } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const parent = yield* sessions.create({})
            const child = yield* sessions.create({
              parentID: parent.id,
              createdByAgentTool: true,
              subagentType: "general",
              permission: [
                { permission: "external_directory", pattern: "/tmp/project/*", action: "allow" },
                { permission: "edit", pattern: "/secret/**", action: "deny" },
                { permission: "edit", pattern: "*", action: "deny" },
              ],
            })

            yield* prompt.prompt({
              sessionID: child.id,
              agent: "build",
              noReply: true,
              tools: { agent: false, "enter-worktree": false },
              parts: [{ type: "text", text: "x" }],
            })

            const after = yield* sessions.get(child.id)
            // Scoped deny + external_directory survive (the boolean tools map can't express them).
            expect(after.permission).toContainEqual({
              permission: "external_directory",
              pattern: "/tmp/project/*",
              action: "allow",
            })
            expect(after.permission).toContainEqual({ permission: "edit", pattern: "/secret/**", action: "deny" })
            // The structural denies the boolean tools map lists are regenerated from it.
            expect(after.permission).toContainEqual({ permission: "agent", pattern: "*", action: "deny" })
            // The whole-tool ("*") edit deny is ALSO carried forward: "edit" is absent from the
            // tools map (which lists only agent/enter-worktree here), so the map can't regenerate
            // it — dropping it would let the caller's edit deny vanish through the child. A
            // whole-tool deny for a key the map DOES list is regenerated instead (next test).
            expect(after.permission).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
          }),
        ),
    })
  }, 30000)

  test("regenerates a whole-tool deny the map lists instead of double-carrying it", async () => {
    await using tmp = await tmpdir({
      config: { agent: { build: { model: "openai/gpt-5.2" } } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const parent = yield* sessions.create({})
            const child = yield* sessions.create({
              parentID: parent.id,
              createdByAgentTool: true,
              subagentType: "general",
              permission: [{ permission: "edit", pattern: "*", action: "deny" }],
            })

            yield* prompt.prompt({
              sessionID: child.id,
              agent: "build",
              noReply: true,
              // "edit" is in the map, so its "*" deny is regenerated from the map — the forwarded
              // copy is dropped from the carry-forward so the ruleset doesn't accumulate.
              tools: { agent: false, edit: false },
              parts: [{ type: "text", text: "x" }],
            })

            const after = yield* sessions.get(child.id)
            expect((after.permission ?? []).filter((r) => r.permission === "edit" && r.pattern === "*")).toHaveLength(1)
            expect(Permission.evaluate("edit", "*", after.permission ?? []).action).toBe("deny")
          }),
        ),
    })
  }, 30000)

  test("carries the caller's wildcard deny forward so tools absent from the map stay denied", async () => {
    await using tmp = await tmpdir({
      config: { agent: { build: { model: "openai/gpt-5.2" } } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const parent = yield* sessions.create({})
            // A read-only-style caller forwards a wildcard ("*") deny onto the child.
            const child = yield* sessions.create({
              parentID: parent.id,
              createdByAgentTool: true,
              subagentType: "general",
              permission: [{ permission: "*", pattern: "*", action: "deny" }],
            })

            yield* prompt.prompt({
              sessionID: child.id,
              agent: "build",
              noReply: true,
              tools: { agent: false, edit: false },
              parts: [{ type: "text", text: "x" }],
            })

            const after = yield* sessions.get(child.id)
            // The wildcard deny is preserved, so a tool absent from the boolean tools map
            // (automate, MCP, custom) still evaluates to deny for the subagent.
            expect(after.permission).toContainEqual({ permission: "*", pattern: "*", action: "deny" })
            expect(Permission.evaluate("automate", "*", after.permission ?? []).action).toBe("deny")
          }),
        ),
    })
  }, 30000)

  test("replaces permission wholesale for a non-agent-tool session", async () => {
    await using tmp = await tmpdir({
      config: { agent: { build: { model: "openai/gpt-5.2" } } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({
              permission: [{ permission: "edit", pattern: "/secret/**", action: "deny" }],
            })

            yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              noReply: true,
              tools: { agent: false },
              parts: [{ type: "text", text: "x" }],
            })

            const after = yield* sessions.get(session.id)
            // Not an agent-tool child → the rebuild replaces wholesale (pre-existing behavior).
            expect(after.permission).not.toContainEqual({ permission: "edit", pattern: "/secret/**", action: "deny" })
            expect(after.permission).toContainEqual({ permission: "agent", pattern: "*", action: "deny" })
          }),
        ),
    })
  }, 30000)
})

// The chain this PR actually restores: a user's explicit model selection on a
// prompt seeds state/model.json's `recent`, which Provider.defaultModel later
// reads so a model-less session (a Telegram /new) inherits it. The pure
// shouldRecordRecent/applyRecent tests cover the helpers; these exercise the
// real prompt → model.json write. (The recent → defaultModel read half is
// covered by provider.test.ts.)
describe("session.prompt seeds the recent default model", () => {
  const modelFile = () => path.join(Global.Path.state, "model.json")

  async function readRecent(): Promise<Array<{ providerID: string; modelID: string }>> {
    try {
      const raw = JSON.parse(await fs.readFile(modelFile(), "utf8"))
      return Array.isArray(raw?.recent) ? raw.recent : []
    } catch {
      return []
    }
  }

  // recordRecent runs detached (fire-and-forget) so it never blocks the prompt;
  // the write lands shortly after prompt() resolves. Poll instead of racing it.
  async function waitForHead(want: { providerID: string; modelID: string }) {
    for (let i = 0; i < 100; i++) {
      const recent = await readRecent()
      if (recent[0]?.providerID === want.providerID && recent[0]?.modelID === want.modelID) return recent
      await new Promise((r) => setTimeout(r, 20))
    }
    return readRecent()
  }

  // model.json lives in the process-wide XDG_STATE_HOME (test preload), so it is
  // shared with provider.test.ts and across these tests. Clear it around each one
  // to keep assertions on recent[0] independent of run order or leftover writes.
  beforeEach(() => fs.rm(modelFile(), { force: true }))
  afterEach(() => fs.rm(modelFile(), { force: true }))

  test("an explicit-model user prompt seeds recent[0]", async () => {
    await using tmp = await tmpdir({ git: true, config: { agent: { build: { model: "openai/gpt-5.2" } } } })
    const picked = { providerID: "deepseek", modelID: "deepseek-chat" }
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({})
            yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              model: { providerID: ProviderID.make(picked.providerID), modelID: ModelID.make(picked.modelID) },
              noReply: true,
              parts: [{ type: "text", text: "hi" }],
            })
            const recent = yield* Effect.promise(() => waitForHead(picked))
            expect(recent[0]).toEqual(picked)
            yield* sessions.remove(session.id)
          }),
        ),
    })
  })

  test("a prompt that only inherits the agent's model does NOT seed recent", async () => {
    // Semantic A: only the user's explicit input.model counts. A model merely
    // derived from the agent (ag.model, used when no input.model is passed) must
    // not become the global default.
    await using tmp = await tmpdir({ git: true, config: { agent: { build: { model: "openai/gpt-5.2" } } } })
    const picked = { providerID: "deepseek", modelID: "deepseek-chat" }
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service

            // Seed deterministically with an explicit selection first.
            const seed = yield* sessions.create({})
            yield* prompt.prompt({
              sessionID: seed.id,
              agent: "build",
              model: { providerID: ProviderID.make(picked.providerID), modelID: ModelID.make(picked.modelID) },
              noReply: true,
              parts: [{ type: "text", text: "hi" }],
            })
            yield* Effect.promise(() => waitForHead(picked))

            // Now a prompt with NO input.model — it runs on the agent's openai/gpt-5.2.
            const agentOnly = yield* sessions.create({})
            yield* prompt.prompt({
              sessionID: agentOnly.id,
              agent: "build",
              noReply: true,
              parts: [{ type: "text", text: "hi" }],
            })
            yield* Effect.promise(() => new Promise((r) => setTimeout(r, 150)))
            const recent = yield* Effect.promise(() => readRecent())
            expect(recent[0]).toEqual(picked) // unchanged
            expect(recent.some((m) => m.providerID === "openai" && m.modelID === "gpt-5.2")).toBe(false)

            yield* sessions.remove(seed.id)
            yield* sessions.remove(agentOnly.id)
          }),
        ),
    })
  })

  test("an automation prompt does NOT seed recent", async () => {
    await using tmp = await tmpdir({ git: true, config: { agent: { build: { model: "openai/gpt-5.2" } } } })
    const picked = { providerID: "deepseek", modelID: "deepseek-chat" }
    const automationModel = { providerID: "qwen", modelID: "qwen-max" }
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service

            const seed = yield* sessions.create({})
            yield* prompt.prompt({
              sessionID: seed.id,
              agent: "build",
              model: { providerID: ProviderID.make(picked.providerID), modelID: ModelID.make(picked.modelID) },
              noReply: true,
              parts: [{ type: "text", text: "hi" }],
            })
            yield* Effect.promise(() => waitForHead(picked))

            const auto = yield* sessions.create({})
            yield* prompt.prompt({
              sessionID: auto.id,
              agent: "build",
              automationID: "auto_1",
              model: {
                providerID: ProviderID.make(automationModel.providerID),
                modelID: ModelID.make(automationModel.modelID),
              },
              noReply: true,
              parts: [{ type: "text", text: "hi" }],
            })
            yield* Effect.promise(() => new Promise((r) => setTimeout(r, 150)))
            const recent = yield* Effect.promise(() => readRecent())
            expect(recent[0]).toEqual(picked) // unchanged
            expect(
              recent.some((m) => m.providerID === automationModel.providerID && m.modelID === automationModel.modelID),
            ).toBe(false)

            yield* sessions.remove(seed.id)
            yield* sessions.remove(auto.id)
          }),
        ),
    })
  })

  test("a prompt whose model equals the agent's configured model does NOT seed recent", async () => {
    // The desktop UI always sends a resolved model, and that model can be the
    // agent's own pin rather than a model-picker choice. Such a model must not
    // become the inherited default (modelFromAgent guard).
    await using tmp = await tmpdir({ git: true, config: { agent: { build: { model: "openai/gpt-5.2" } } } })
    const picked = { providerID: "deepseek", modelID: "deepseek-chat" }
    const agentPin = { providerID: "openai", modelID: "gpt-5.2" }
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service

            // Seed deterministically with an explicit selection first.
            const seed = yield* sessions.create({})
            yield* prompt.prompt({
              sessionID: seed.id,
              agent: "build",
              model: { providerID: ProviderID.make(picked.providerID), modelID: ModelID.make(picked.modelID) },
              noReply: true,
              parts: [{ type: "text", text: "hi" }],
            })
            yield* Effect.promise(() => waitForHead(picked))

            // Now a prompt that explicitly carries the agent's own pinned model.
            const onAgentModel = yield* sessions.create({})
            yield* prompt.prompt({
              sessionID: onAgentModel.id,
              agent: "build",
              model: { providerID: ProviderID.make(agentPin.providerID), modelID: ModelID.make(agentPin.modelID) },
              noReply: true,
              parts: [{ type: "text", text: "hi" }],
            })
            yield* Effect.promise(() => new Promise((r) => setTimeout(r, 150)))
            const recent = yield* Effect.promise(() => readRecent())
            expect(recent[0]).toEqual(picked) // unchanged
            expect(recent.some((m) => m.providerID === agentPin.providerID && m.modelID === agentPin.modelID)).toBe(
              false,
            )

            yield* sessions.remove(seed.id)
            yield* sessions.remove(onAgentModel.id)
          }),
        ),
    })
  })
})
