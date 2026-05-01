import { describe, expect, test } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Log } from "@opencode-ai/core/util/log"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import type { PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SubagentRun } from "../../src/session/subagent-run"
import { SubagentRunGuardViolation } from "../../src/session/subagent-run-context"
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

  test("reports whether a parent has active subagent slots", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const program = Effect.gen(function* () {
          const svc = yield* SubagentRun.Service
          const parentID = "ses_parent_active" as SessionID

          expect(yield* svc.activeForSession(parentID)).toBe(false)
          yield* svc.reserveSlot(parentID)
          expect(yield* svc.activeForSession(parentID)).toBe(true)
          yield* svc.releaseSlot(parentID)
          expect(yield* svc.activeForSession(parentID)).toBe(false)
        })
        await Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(SubagentRun.defaultLayer, Session.defaultLayer))))
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

  test("recordRejected writes a failed SubtaskPart with too_many_active error", async () => {
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
          const part = yield* svc.recordRejected({
            parent_session_id: parent.id,
            parent_message_id: msg.id,
            tool_call_id: "call_rej",
            description: "review",
            prompt: "hi",
            agent: "build",
            model: ref,
            reason: "Wait or reduce dispatch.",
          })
          expect(part.status).toBe("failed")
          expect(part.error?.kind).toBe("too_many_active")
          expect(part.error?.message).toBe("Wait or reduce dispatch.")
          expect(part.subagent_session_id).toBeUndefined()
          expect(part.recent_events.map((e) => e.type)).toEqual(["started", "failed"])
        })
        await Effect.runPromise(
          program.pipe(
            Effect.provide(Layer.mergeAll(SubagentRun.defaultLayer, Session.defaultLayer)),
          ),
        )
      },
    })
  })

  test("slot mutex serializes reservations and releases under sequential dispatch", async () => {
    // The slot semaphore is a Semaphore.makeUnsafe(1) per parent. Lock-ordering
    // invariant: slot mutex is acquired BEFORE per-row mutex everywhere; row mutex
    // operations never call back into reserveSlot. This test asserts that 5 sequential
    // reservations + 1 cap rejection + interleaved releases never deadlock the service.
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

          // Reserve 5 slots and start a row for each. Row writes (start) acquire the
          // per-row mutex; if start ever called back into reserveSlot, this loop would
          // deadlock on iteration 6 (since slot is held while waiting for row, and
          // row would wait for slot).
          for (let i = 0; i < 5; i++) {
            yield* svc.reserveSlot(parent.id)
            yield* svc.start({
              parent_session_id: parent.id,
              parent_message_id: msg.id,
              tool_call_id: `call_lock_${i}`,
              description: `dispatch ${i}`,
              prompt: "x",
              agent: "build",
              model: ref,
            })
          }

          // 6th reservation is rejected.
          const sixth = yield* svc.reserveSlot(parent.id).pipe(Effect.flip)
          expect(sixth._tag).toBe("TooManyActive")

          // Release all 5 slots, then re-reserve to confirm the slot count is back to
          // zero. Releases interleaved with reads of the row (read acquires no mutex
          // but reads from the in-memory map populated by start) — proves no implicit
          // dependency cycle.
          for (let i = 0; i < 5; i++) {
            yield* svc.read(`call_lock_${i}`)
            yield* svc.releaseSlot(parent.id)
          }
          yield* svc.reserveSlot(parent.id)
          yield* svc.releaseSlot(parent.id)
        })
        await Effect.runPromise(
          program.pipe(
            Effect.provide(Layer.mergeAll(SubagentRun.defaultLayer, Session.defaultLayer)),
          ),
        )
      },
    })
  })

  test("allows first-write of a SubtaskPart with persisted lifecycle values (Session.fork compatibility)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ref = { providerID: "anthropic" as ProviderID, modelID: "claude-3-5-sonnet" as ModelID }
        const program = Effect.gen(function* () {
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
          const partID = "prt_first_write" as PartID
          const cloned: MessageV2.SubtaskPart = {
            type: "subtask",
            id: partID,
            sessionID: parent.id,
            messageID: msg.id,
            prompt: "review me",
            description: "review",
            agent: "build",
            model: ref,
            tool_call_id: "call_fork_clone",
            parent_session_id: parent.id,
            parent_message_id: msg.id,
            subagent_session_id: undefined,
            status: "completed",
            started_at: Date.now() - 1_000,
            ended_at: Date.now(),
            updated_at: Date.now(),
            recent_events: [
              { type: "started", at: Date.now() - 1_000 },
              { type: "completed", at: Date.now() },
            ],
            result_text: "looks good",
            result_summary: "looks good",
          }
          // Non-writer path (Session.fork replays parts via updatePart without
          // SubagentRunWriterContext). Must succeed because this is a first write,
          // not a lifecycle mutation of an existing row.
          const exit = yield* session.updatePart(cloned).pipe(Effect.exit)
          expect(exit._tag).toBe("Success")
        })
        await Effect.runPromise(
          program.pipe(
            Effect.provide(Layer.mergeAll(SubagentRun.defaultLayer, Session.defaultLayer)),
          ),
        )
      },
    })
  })

  test("rejects direct Session.updatePart writes that mutate lifecycle fields", async () => {
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
            tool_call_id: "call_guard",
            description: "review",
            prompt: "hi",
            agent: "build",
            model: ref,
          })
          // Direct write that flips status — should be rejected as a defect with the specific
          // SubagentRunGuardViolation tag and the violating tool_call_id, so this test fails
          // loudly if updatePart starts failing for an unrelated reason in the future.
          const exit = yield* session
            .updatePart({ ...part, status: "completed" as const })
            .pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
          if (exit._tag !== "Failure") return
          const violation = exit.cause.reasons
            .filter(Cause.isDieReason)
            .map((r) => r.defect)
            .find((d): d is SubagentRunGuardViolation => d instanceof SubagentRunGuardViolation)
          expect(violation).toBeDefined()
          expect(violation?.tool_call_id).toBe("call_guard")
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
