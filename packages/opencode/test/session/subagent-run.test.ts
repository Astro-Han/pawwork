import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Log } from "@opencode-ai/core/util/log"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import type { SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SubagentRun } from "../../src/session/subagent-run"
import { tmpdir } from "../fixture/fixture"

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

void Log.init({ print: false })

describe("SubtaskPart backward compat", () => {
  test("decodes a legacy row lacking lifecycle fields as terminal-completed", () => {
    const legacy = {
      type: "subtask" as const,
      id: "prt_legacy",
      sessionID: "ses_x",
      messageID: "msg_x",
      prompt: "old",
      description: "old",
      agent: "build",
    }
    const decoded = MessageV2.SubtaskPart.parse(legacy)
    expect(decoded.status).toBe("completed")
    expect(decoded.recent_events).toEqual([])
    expect(decoded.started_at).toBeUndefined()
    expect(decoded.tool_call_id).toBeUndefined()
  })

  test("rejects more than 5 concurrent reservations per parent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const program = Effect.gen(function* () {
          const svc = yield* SubagentRun.Service
          const parentID = "ses_parent_cap" as SessionID
          for (let i = 0; i < 5; i++) yield* svc.reserveSlot(parentID)
          const sixth = yield* svc.reserveSlot(parentID).pipe(Effect.flip)
          expect(sixth._tag).toBe("TooManyActive")
          // releasing one frees a slot
          yield* svc.releaseSlot(parentID)
          yield* svc.reserveSlot(parentID) // should succeed
        })
        await Effect.runPromise(
          program.pipe(
            Effect.provide(Layer.mergeAll(SubagentRun.defaultLayer, Session.defaultLayer)),
          ),
        )
      },
    })
  })

  test("start writes a running SubtaskPart on the parent message", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const program = Effect.gen(function* () {
          const svc = yield* SubagentRun.Service
          const session = yield* Session.Service
          const parent = yield* session.create({})
          const msg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: parent.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          const part = yield* svc.start({
            parent_session_id: parent.id,
            parent_message_id: msg.id,
            tool_call_id: "call_abc",
            description: "review",
            prompt: "hi",
            agent: "build",
            subagent_type: "reviewer",
            model: ref,
          })
          expect(part.status).toBe("running")
          expect(part.tool_call_id).toBe("call_abc")
          expect(part.subagent_session_id).toBeUndefined()
          expect(part.recent_events.map((e) => e.type)).toEqual(["started"])

          yield* svc.finalize("call_abc", "completed", { result_text: "done" })
          const final = yield* svc.read("call_abc")
          expect(final.status).toBe("completed")
          expect(final.result_text).toBe("done")
          expect(final.ended_at).toBeDefined()
        })
        await Effect.runPromise(
          program.pipe(
            Effect.provide(Layer.mergeAll(SubagentRun.defaultLayer, Session.defaultLayer)),
          ),
        )
      },
    })
  })

  test("recent_events ring pins lifecycle events and evicts progress FIFO", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const program = Effect.gen(function* () {
          const svc = yield* SubagentRun.Service
          const session = yield* Session.Service
          const parent = yield* session.create({})
          const msg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: parent.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* svc.start({
            parent_session_id: parent.id,
            parent_message_id: msg.id,
            tool_call_id: "call_ring",
            description: "review",
            prompt: "hi",
            agent: "build",
            subagent_type: "reviewer",
            model: ref,
          })
          for (let i = 0; i < 30; i++) {
            yield* svc.recordEvent("call_ring", {
              type: "tool_started",
              tool: "read",
              label: `f${i}.ts`,
              at: Date.now() + i,
            })
            yield* svc.recordEvent("call_ring", {
              type: "tool_completed",
              tool: "read",
              at: Date.now() + i + 0.5,
            })
          }
          yield* svc.finalize("call_ring", "completed", { result_text: "done" })
          const final = yield* svc.read("call_ring")
          expect(final.recent_events.find((e) => e.type === "started")).toBeDefined()
          expect(final.recent_events.length).toBeLessThanOrEqual(20)
        })
        await Effect.runPromise(
          program.pipe(
            Effect.provide(Layer.mergeAll(SubagentRun.defaultLayer, Session.defaultLayer)),
          ),
        )
      },
    })
  })

  test("accepts a row with all new lifecycle fields populated", () => {
    const full = {
      type: "subtask" as const,
      id: "prt_new",
      sessionID: "ses_x",
      messageID: "msg_x",
      prompt: "p",
      description: "d",
      agent: "build",
      tool_call_id: "call_1",
      parent_session_id: "ses_x",
      parent_message_id: "msg_x",
      subagent_session_id: "ses_child",
      status: "running" as const,
      started_at: 1000,
      updated_at: 1500,
      recent_events: [{ type: "started" as const, at: 1000 }],
    }
    const decoded = MessageV2.SubtaskPart.parse(full)
    expect(decoded.status).toBe("running")
    expect(decoded.tool_call_id).toBe("call_1")
    expect(decoded.recent_events).toHaveLength(1)
  })
})

describe("Session.create new fields", () => {
  test("persists createdByAgentTool and subagentType", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const created = await Session.create({
          title: "child",
          createdByAgentTool: true,
          subagentType: "reviewer",
        })
        const fetched = await Session.get(created.id)
        expect(fetched.createdByAgentTool).toBe(true)
        expect(fetched.subagentType).toBe("reviewer")
      },
    })
  })

  test("defaults are false / null when not provided", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const created = await Session.create({ title: "plain" })
        const fetched = await Session.get(created.id)
        expect(fetched.createdByAgentTool).toBe(false)
        expect(fetched.subagentType).toBeNull()
      },
    })
  })
})
