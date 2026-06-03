import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageID, SessionID } from "../../src/session/schema"
import { ExternalResult } from "../../src/tool/external-result"
import { tmpdir } from "../fixture/fixture"

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => AppRuntime.runPromise(effect as never) as Promise<A>

beforeEach(() => {
  ExternalResult.__resetForTests()
})

afterEach(async () => {
  ExternalResult.__resetForTests()
  await Instance.disposeAll()
})

// Minimal question-shaped snapshot for decoder tests. The decoder only
// needs `questions[].options[].label`, `multiple`, and `custom`; full
// QuestionPrompt validation lives in the question tool itself.
const oneQuestionSnapshot = {
  questions: [
    {
      question: "Pick one",
      options: [{ label: "Yes" }, { label: "No" }],
      multiple: false,
      custom: false,
    },
  ],
}
const passThroughDecoder = (payload: unknown): ExternalResult.DecodeResult => ({
  ok: true,
  value: payload,
})
const rejectCountDecoder = (payload: unknown, snapshot: unknown): ExternalResult.DecodeResult => {
  const expected = (snapshot as { questions: unknown[] }).questions.length
  const got = ((payload as { answers?: unknown[] }).answers ?? []).length
  if (got !== expected) return { ok: false, error: "answer_count_mismatch", details: { expected, got } }
  return { ok: true, value: payload }
}

describe("POST /session/:sessionID/tool/respond", () => {
  test("submit resolves the registered Deferred and returns 200", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const session = await run(Session.Service.use((svc) => svc.create({})))
        const messageID = MessageID.make("msg_submit_1")
        const callID = "call_submit_1"
        const deferred = await run(
          ExternalResult.register({
            sessionID: session.id,
            messageID,
            callID,
            inputSnapshot: { foo: 1 },
            decoder: passThroughDecoder,
          }),
        )

        const res = await app.request(`/session/${session.id}/tool/respond`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "submit",
            messageID,
            callID,
            payload: { answers: [["yes"]] },
          }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ status: "ok" })

        const resolved = await run(Deferred.await(deferred))
        expect(resolved).toEqual({ kind: "submitted", value: { answers: [["yes"]] } })
        expect(ExternalResult.hasPending(session.id)).toBe(false)
      },
    })
  })

  test("decoderless tool forwards raw payload to the Deferred", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const session = await run(Session.Service.use((svc) => svc.create({})))
        const messageID = MessageID.make("msg_nodecoder")
        const callID = "call_nodecoder"
        const deferred = await run(
          ExternalResult.register({
            sessionID: session.id,
            messageID,
            callID,
            inputSnapshot: {},
          }),
        )
        const res = await app.request(`/session/${session.id}/tool/respond`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "submit", messageID, callID, payload: { whatever: true } }),
        })
        expect(res.status).toBe(200)
        const resolved = await run(Deferred.await(deferred))
        expect(resolved).toEqual({ kind: "submitted", value: { whatever: true } })
      },
    })
  })

  test("decoder rejects malformed payload with 422 and leaves entry pending for retry", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const session = await run(Session.Service.use((svc) => svc.create({})))
        const messageID = MessageID.make("msg_decoder_fail")
        const callID = "call_decoder_fail"
        const deferred = await run(
          ExternalResult.register({
            sessionID: session.id,
            messageID,
            callID,
            inputSnapshot: oneQuestionSnapshot,
            decoder: rejectCountDecoder,
          }),
        )

        // First POST: malformed (0 answers when 1 expected).
        const bad = await app.request(`/session/${session.id}/tool/respond`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "submit",
            messageID,
            callID,
            payload: { answers: [] },
          }),
        })
        expect(bad.status).toBe(422)
        const badBody = await bad.json()
        expect(badBody.error).toBe("answer_count_mismatch")
        expect(badBody.details).toEqual({ expected: 1, got: 0 })

        // Deferred MUST still be pending; entry MUST still be lookupable.
        expect(ExternalResult.hasPending(session.id)).toBe(true)

        // Second POST with corrected payload: 200, deferred resolves.
        const good = await app.request(`/session/${session.id}/tool/respond`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "submit",
            messageID,
            callID,
            payload: { answers: [["Yes"]] },
          }),
        })
        expect(good.status).toBe(200)
        const resolved = await run(Deferred.await(deferred))
        expect(resolved).toEqual({ kind: "submitted", value: { answers: [["Yes"]] } })
      },
    })
  })

  test("dismiss resolves the Deferred with kind=dismissed and returns 200 (skips decoder)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const session = await run(Session.Service.use((svc) => svc.create({})))
        const messageID = MessageID.make("msg_dismiss_1")
        const callID = "call_dismiss_1"
        const deferred = await run(
          ExternalResult.register({
            sessionID: session.id,
            messageID,
            callID,
            inputSnapshot: oneQuestionSnapshot,
            // Even with a strict decoder, dismiss must short-circuit.
            decoder: rejectCountDecoder,
          }),
        )

        const res = await app.request(`/session/${session.id}/tool/respond`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "dismiss", messageID, callID }),
        })
        expect(res.status).toBe(200)

        const resolved = await run(Deferred.await(deferred))
        expect(resolved).toEqual({ kind: "dismissed" })
      },
    })
  })

  test("unknown (sessionID, messageID, callID) returns 404", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const session = await run(Session.Service.use((svc) => svc.create({})))
        const res = await app.request(`/session/${session.id}/tool/respond`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "submit",
            messageID: MessageID.make("msg_unknown"),
            callID: "call_unknown",
            payload: null,
          }),
        })
        expect(res.status).toBe(404)
      },
    })
  })

  test("double-submit within tombstone TTL returns 409", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const session = await run(Session.Service.use((svc) => svc.create({})))
        const messageID = MessageID.make("msg_double_1")
        const callID = "call_double_1"
        await run(
          ExternalResult.register({
            sessionID: session.id,
            messageID,
            callID,
            inputSnapshot: {},
            decoder: passThroughDecoder,
          }),
        )

        const body = JSON.stringify({ kind: "submit", messageID, callID, payload: 1 })
        const first = await app.request(`/session/${session.id}/tool/respond`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        })
        expect(first.status).toBe(200)

        const second = await app.request(`/session/${session.id}/tool/respond`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        })
        expect(second.status).toBe(409)
      },
    })
  })

  test("malformed outer body returns 400 (zod discriminatedUnion default)", async () => {
    // Note: the zod validator on the route returns 400 for wrong-shape
    // bodies (missing/unknown `kind`). 422 is reserved for tool-owned
    // decoder failures on submit payloads — see the decoder-reject test
    // above. The two error sources are distinct contracts.
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const session = await run(Session.Service.use((svc) => svc.create({})))
        const res = await app.request(`/session/${session.id}/tool/respond`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "bogus" }),
        })
        expect(res.status).toBe(400)
      },
    })
  })

  test("declares its route-local failure bodies in OpenAPI", async () => {
    const spec = await Server.openapi()
    const responses = spec.paths?.["/session/{sessionID}/tool/respond"]?.post?.responses

    // 404 / 409 / 422 carry the inline route-local { error, details? } body,
    // not the shared NotFoundError envelope. Asserting the inline schema keeps
    // this robust against component-ref registration order across the suite.
    for (const status of ["404", "409", "422"] as const) {
      const response = responses?.[status]
      if (!response || "$ref" in response) throw new Error(`expected inline ${status} response`)
      expect(response.content?.["application/json"]?.schema, status).toMatchObject({
        type: "object",
        properties: { error: { type: "string" } },
        required: ["error"],
      })
    }
  })
})
