import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session"
import { Todo } from "../../src/session/todo"
import { InvalidTool } from "../../src/tool/invalid"
import { PlanExitTool } from "../../src/tool/plan"
import { QuestionTool } from "../../src/tool/question"
import { TodoWriteTool } from "../../src/tool/todo"
import * as Tool from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { ProviderTest } from "../fake/provider"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const providerID = ProviderID.make("tool-tail-provider")
const modelID = ModelID.make("tool-tail-model")
const provider = ProviderTest.fake({
  model: ProviderTest.model({ providerID, id: modelID }),
  defaultModel: Effect.fn("ToolTailTest.defaultModel")(() => Effect.die(new Error("defaultModel should not be used"))),
})

const it = testEffect(
  Layer.mergeAll(
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Session.defaultLayer,
    Todo.defaultLayer,
    provider.layer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

const baseCtx = (overrides: Partial<Tool.Context> = {}): Tool.Context => ({
  sessionID: SessionID.make("ses_tool_tail"),
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  ...overrides,
})

afterEach(async () => {
  await Instance.disposeAll()
})

describe("low-tail tool Effect migration", () => {
  it.live("question tool initializes and resolves submitted external answers through its decoder", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const info = yield* QuestionTool
        const tool = yield* info.init()
        const params: Tool.InferParameters<typeof QuestionTool> = {
          questions: [
            {
              question: "Pick one",
              header: "Choice",
              custom: false,
              multiple: false,
              options: [
                { label: "Yes", description: "Proceed" },
                { label: "No", description: "Stop" },
              ],
            },
          ],
        }

        const result = yield* tool.execute(
          params,
          baseCtx({
            externalResult: ({ inputSnapshot, decoder }) =>
              Effect.sync(() => {
                expect(inputSnapshot).toEqual(params)
                const decoded = decoder?.({ answers: [[" Yes "]] }, inputSnapshot)
                expect(decoded).toEqual({ ok: true, value: { answers: [["Yes"]] } })
                if (!decoded?.ok) throw new Error("expected decoder success")
                return { kind: "submitted", value: decoded.value }
              }),
          }),
        )

        expect(result.title).toBe("Asked 1 question")
        expect(result.output).toContain('"Pick one"="Yes"')
        expect(result.metadata).toMatchObject({ answers: [["Yes"]], dismissed: false })
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)
      }),
    ),
  )

  it.live("todowrite tool initializes with Todo.Service and persists revisioned todos", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service.use((svc) => svc.create({ title: "tool todo" }))
        const info = yield* TodoWriteTool
        const tool = yield* info.init()
        const askCalls: unknown[] = []

        const result = yield* tool.execute(
          {
            todos: [{ content: "Ship Effect tool tail", status: "pending", priority: "medium" }],
          },
          baseCtx({
            sessionID: session.id,
            ask: (input) =>
              Effect.sync(() => {
                askCalls.push(input)
              }),
          }),
        )

        const stored = yield* Todo.Service.use((svc) => svc.get(session.id))
        expect(askCalls).toEqual([
          { permission: "todowrite", patterns: ["*"], always: ["*"], metadata: {} },
        ])
        expect(result.title).toBe("1 todos")
        expect(result.metadata.revision).toBe(1)
        expect(result.metadata.todos[0].id).toStartWith("todo_")
        expect(JSON.parse(result.output)).toEqual(result.metadata.todos)
        expect(stored).toEqual({ revision: result.metadata.revision, todos: result.metadata.todos })
      }),
      { git: true },
    ),
  )

  it.live("invalid tool initializes and returns the repair fallback shape", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const info = yield* InvalidTool
        const tool = yield* info.init()

        const result = yield* tool.execute({ tool: "missing_tool", error: "Unknown tool" }, baseCtx())

        expect(result.title).toBe("Invalid Tool")
        expect(result.output).toBe("The arguments provided to the tool are invalid: Unknown tool")
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)
      }),
    ),
  )

  it.effect("plan_exit tool writes the build-agent handoff using the Effect clock", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const session = yield* sessionSvc.create({ title: "plan exit" })
        yield* sessionSvc.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: 1 },
          agent: "plan",
          model: { providerID, modelID },
        } satisfies MessageV2.User)

        const info = yield* PlanExitTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          {},
          baseCtx({
            sessionID: session.id,
            externalResult: ({ inputSnapshot, decoder }) =>
              Effect.sync(() => {
                const decoded = decoder?.({ answers: [["Yes"]] }, inputSnapshot)
                expect(decoded).toEqual({ ok: true, value: { answers: [["Yes"]] } })
                if (!decoded?.ok) throw new Error("expected decoder success")
                return { kind: "submitted", value: decoded.value }
              }),
          }),
        )

        const messages = yield* sessionSvc.messages({ sessionID: session.id })
        const build = messages.find(
          (message): message is MessageV2.WithParts & { info: MessageV2.User } =>
            message.info.role === "user" && message.info.agent === "build",
        )
        expect(result.title).toBe("Switching to build agent")
        expect(result.output).toContain("User approved switching to build agent")
        expect(build?.info.model).toEqual({ providerID, modelID })
        expect(build?.info.time.created).toBe(0)
        expect(build?.parts).toContainEqual(
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("Execute the plan"),
            synthetic: true,
          } satisfies Partial<MessageV2.TextPart>),
        )
      }),
      { git: true },
    ),
  )
})
