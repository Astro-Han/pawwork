import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Log } from "@opencode-ai/core/util/log"
import { MessageID, type SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SubagentRun } from "../../src/session/subagent-run"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const setup = (
  body: (api: {
    svc: SubagentRun.Interface
    sessions: Session.Interface
    parent: Session.Info
    messageID: MessageID
  }) => Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    const svc = yield* SubagentRun.Service
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({})
    const msg = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: parent.id,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* body({ svc, sessions, parent, messageID: msg.id })
  })

const run = (program: Effect.Effect<void, unknown, SubagentRun.Service | Session.Service>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(Layer.mergeAll(SubagentRun.defaultLayer, Session.defaultLayer)),
      Effect.orDie,
    ),
  )

describe("subagent lifecycle integration", () => {
  test("completed terminal state with result_text", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          setup(({ svc, parent, messageID }) =>
            Effect.gen(function* () {
              yield* svc.start({
                parent_session_id: parent.id,
                parent_message_id: messageID,
                tool_call_id: "call_completed",
                description: "review",
                prompt: "x",
                agent: "build",
                model: ref,
              })
              yield* svc.finalize("call_completed", "completed", {
                result_text: "all good",
                result_summary: "all good",
              })
              const part = yield* svc.read("call_completed")
              expect(part.status).toBe("completed")
              expect(part.result_text).toBe("all good")
              expect(part.ended_at).toBeDefined()
            }),
          ),
        ),
    })
  })

  test("completed_empty terminal state when result_text is blank", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          setup(({ svc, parent, messageID }) =>
            Effect.gen(function* () {
              yield* svc.start({
                parent_session_id: parent.id,
                parent_message_id: messageID,
                tool_call_id: "call_empty",
                description: "noop",
                prompt: "x",
                agent: "build",
                model: ref,
              })
              yield* svc.finalize("call_empty", "completed_empty", {})
              const part = yield* svc.read("call_empty")
              expect(part.status).toBe("completed_empty")
              expect(part.result_text).toBeUndefined()
            }),
          ),
        ),
    })
  })

  test("failed terminal state with execution_error", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          setup(({ svc, parent, messageID }) =>
            Effect.gen(function* () {
              yield* svc.start({
                parent_session_id: parent.id,
                parent_message_id: messageID,
                tool_call_id: "call_failed",
                description: "fail",
                prompt: "x",
                agent: "build",
                model: ref,
              })
              yield* svc.finalize("call_failed", "failed", {
                error: { kind: "execution_error", message: "model returned 500" },
              })
              const part = yield* svc.read("call_failed")
              expect(part.status).toBe("failed")
              expect(part.error?.kind).toBe("execution_error")
            }),
          ),
        ),
    })
  })

  test("failed terminal state with too_many_active via recordRejected", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          setup(({ svc, parent, messageID }) =>
            Effect.gen(function* () {
              const part = yield* svc.recordRejected({
                parent_session_id: parent.id,
                parent_message_id: messageID,
                tool_call_id: "call_capped",
                description: "review",
                prompt: "x",
                agent: "build",
                model: ref,
                reason: "limit exceeded",
              })
              expect(part.status).toBe("failed")
              expect(part.error?.kind).toBe("too_many_active")
              // No transient running state recorded.
              expect(part.recent_events.find((e) => e.type === "started")?.at).toBeDefined()
              expect(part.recent_events.find((e) => e.type === "failed")?.at).toBeDefined()
            }),
          ),
        ),
    })
  })

  test("canceled_by_user terminal state with partial_result", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          setup(({ svc, parent, messageID }) =>
            Effect.gen(function* () {
              yield* svc.start({
                parent_session_id: parent.id,
                parent_message_id: messageID,
                tool_call_id: "call_canceled",
                description: "cancel",
                prompt: "x",
                agent: "build",
                model: ref,
              })
              yield* svc.finalize("call_canceled", "canceled_by_user", {
                partial_result: "partial work",
              })
              const part = yield* svc.read("call_canceled")
              expect(part.status).toBe("canceled_by_user")
              expect(part.partial_result).toBe("partial work")
            }),
          ),
        ),
    })
  })

  test("findLatestBySessionID returns the most recent matching row", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          setup(({ svc, parent, messageID }) =>
            Effect.gen(function* () {
              const childID = "ses_child_for_resume" as SessionID
              yield* svc.start({
                parent_session_id: parent.id,
                parent_message_id: messageID,
                tool_call_id: "call_a",
                description: "first",
                prompt: "x",
                agent: "build",
                model: ref,
              })
              yield* svc.patchSession("call_a", childID)
              yield* svc.finalize("call_a", "completed", { result_text: "first" })
              // 1ms delay to ensure distinct timestamps
              yield* Effect.sleep("5 millis")
              yield* svc.start({
                parent_session_id: parent.id,
                parent_message_id: messageID,
                tool_call_id: "call_b",
                description: "second",
                prompt: "x",
                agent: "build",
                model: ref,
              })
              yield* svc.patchSession("call_b", childID)
              const latest = yield* svc.findLatestBySessionID(parent.id, childID)
              expect(latest.tool_call_id).toBe("call_b")
            }),
          ),
        ),
    })
  })

  test("list filters running vs completed correctly", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          setup(({ svc, parent, messageID }) =>
            Effect.gen(function* () {
              yield* svc.start({
                parent_session_id: parent.id,
                parent_message_id: messageID,
                tool_call_id: "call_run",
                description: "running one",
                prompt: "x",
                agent: "build",
                model: ref,
              })
              yield* svc.start({
                parent_session_id: parent.id,
                parent_message_id: messageID,
                tool_call_id: "call_done",
                description: "completed one",
                prompt: "x",
                agent: "build",
                model: ref,
              })
              yield* svc.finalize("call_done", "completed", { result_text: "ok" })
              const running = yield* svc.list(parent.id, { status: "running", limit: 10 })
              const completed = yield* svc.list(parent.id, { status: "completed", limit: 10 })
              const all = yield* svc.list(parent.id, { status: "all", limit: 10 })
              expect(running.map((p) => p.tool_call_id)).toEqual(["call_run"])
              expect(completed.map((p) => p.tool_call_id)).toEqual(["call_done"])
              expect(all.length).toBe(2)
            }),
          ),
        ),
    })
  })
})
