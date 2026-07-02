import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import { Log } from "@opencode-ai/core/util/log"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })
const previousRuntimeNamespace = process.env.PAWWORK_RUNTIME_NAMESPACE

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  remove(id: Parameters<SessionNs.Interface["remove"]>[0]) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
}

afterEach(async () => {
  if (previousRuntimeNamespace === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
  else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntimeNamespace
  await Instance.disposeAll()
})

describe("session runtime routes", () => {
  test("share, unshare, diff, artifacts, command, and shell routes are wired through the instance router", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork-test"
        const session = await svc.create({})

        const app = Server.Default().app

        const shareRes = await app.request(`/session/${session.id}/share`, { method: "POST" })
        expect(shareRes.status).toBe(410)
        expect(await shareRes.json()).toEqual({ error: "cloud_share_disabled" })

        const unshareRes = await app.request(`/session/${session.id}/share`, { method: "DELETE" })
        expect(unshareRes.status).toBe(410)
        expect(await unshareRes.json()).toEqual({ error: "cloud_share_disabled" })

        const artifactsRes = await app.request(`/session/${session.id}/artifacts`)
        expect(artifactsRes.status).toBe(200)
        expect(Array.isArray(await artifactsRes.json())).toBe(true)

        const diffRes = await app.request(`/session/${session.id}/diff`)
        expect(diffRes.status).toBe(200)
        expect(await diffRes.json()).toHaveProperty("kind")

        const commandRes = await app.request(`/session/${session.id}/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: "missing-command",
            arguments: "",
          }),
        })
        expect(commandRes.status).toBe(500)
        expect((await commandRes.json()).data.message).toContain('Command not found: "missing-command"')

        const shellRes = await app.request(`/session/${session.id}/shell`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", modelID: "test" },
            command: "printf route-shell-ok",
          }),
        })
        const shell = await shellRes.json()
        expect(shellRes.status).toBe(200)
        expect(shell.info.role).toBe("assistant")
        expect(shell.parts[0]?.state.output).toBe("route-shell-ok")

        await svc.remove(session.id)
      },
    })
  })
})
