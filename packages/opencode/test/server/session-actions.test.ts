import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import type { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: Parameters<typeof SessionNs.create>[0]) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  remove(id: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
}

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

describe("session action routes", () => {
  test("abort route returns success", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const cancel = spyOn(SessionPrompt, "cancel").mockResolvedValue(true)
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/abort`, { method: "POST" })

        expect(res.status).toBe(200)
        expect(await res.json()).toBe(true)
        expect(cancel).toHaveBeenCalledWith(session.id, { mode: "hard" })

        await svc.remove(session.id)
      },
    })
  })

  test("abort route forwards token source", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const cancel = spyOn(SessionPrompt, "cancel").mockResolvedValue(true)
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/abort?mode=soft&source=renderer.stopButton`, {
          method: "POST",
        })

        expect(res.status).toBe(200)
        expect(await res.json()).toBe(true)
        expect(cancel).toHaveBeenCalledWith(session.id, { mode: "soft", source: "renderer.stopButton" })

        await svc.remove(session.id)
      },
    })
  })

  test("abort route rejects non-token source", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const cancel = spyOn(SessionPrompt, "cancel").mockResolvedValue(true)
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/abort?source=renderer%20stop`, { method: "POST" })

        expect(res.status).toBe(400)
        expect(cancel).not.toHaveBeenCalled()

        await svc.remove(session.id)
      },
    })
  })
})
