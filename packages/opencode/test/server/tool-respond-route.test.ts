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
          }),
        )

        const res = await app.request(`/session/${session.id}/tool/respond`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "submit",
            messageID,
            callID,
            payload: { answers: ["yes"] },
          }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ status: "ok" })

        const resolved = await run(Deferred.await(deferred))
        expect(resolved).toEqual({ kind: "submitted", value: { answers: ["yes"] } })
        expect(ExternalResult.hasPending(session.id)).toBe(false)
      },
    })
  })

  test("dismiss resolves the Deferred with kind=dismissed and returns 200", async () => {
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
            inputSnapshot: {},
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
          ExternalResult.register({ sessionID: session.id, messageID, callID, inputSnapshot: {} }),
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

  test("malformed body shape returns 4xx (kind missing or wrong)", async () => {
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
        expect(res.status).toBeGreaterThanOrEqual(400)
        expect(res.status).toBeLessThan(500)
      },
    })
  })
})
