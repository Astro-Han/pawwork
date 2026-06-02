import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
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
  await Instance.disposeAll()
})

describe("session core routes", () => {
  test("get, children, update, fork, and delete use the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await svc.create({ title: "root-session" })
        const child = await svc.create({ title: "child-session", parentID: root.id })
        let forkID: SessionID | undefined

        try {
          const app = Server.Default().app

          const getRes = await app.request(`/session/${root.id}`)
          expect(getRes.status).toBe(200)
          expect((await getRes.json()).id).toBe(root.id)

          const childrenRes = await app.request(`/session/${root.id}/children`)
          const children = await childrenRes.json()
          expect(childrenRes.status).toBe(200)
          expect(children.map((session: { id: string }) => session.id)).toContain(child.id)

          const updateRes = await app.request(`/session/${root.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "renamed-session" }),
          })
          const updated = await updateRes.json()
          expect(updateRes.status).toBe(200)
          expect(updated.title).toBe("renamed-session")

          const forkRes = await app.request(`/session/${root.id}/fork`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          })
          const fork = await forkRes.json()
          forkID = fork.id
          expect(forkRes.status).toBe(200)
          expect(typeof fork.id).toBe("string")
          expect(fork.id).not.toBe(root.id)

          const deleteRes = await app.request(`/session/${fork.id}`, { method: "DELETE" })
          forkID = undefined
          expect(deleteRes.status).toBe(200)
          expect(await deleteRes.json()).toBe(true)
        } finally {
          if (forkID) await svc.remove(forkID).catch(() => undefined)
          await svc.remove(child.id).catch(() => undefined)
          await svc.remove(root.id).catch(() => undefined)
        }
      },
    })
  })
})
