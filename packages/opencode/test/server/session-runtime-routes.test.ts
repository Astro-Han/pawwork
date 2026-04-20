import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionShare } from "../../src/share/session"
import { Log } from "../../src/util/log"
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
  remove(id: Parameters<typeof SessionNs.remove>[0]) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
}

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

describe("session runtime routes", () => {
  test("share, unshare, artifacts, command, and shell routes are wired through the instance router", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})

        const shared = { ...session, share: { url: "https://share.example/s/demo" } }
        const unshared = { ...session, share: undefined }

        const shareSpy = spyOn(SessionShare, "share").mockResolvedValue({ url: shared.share!.url } as any)
        const unshareSpy = spyOn(SessionShare, "unshare").mockResolvedValue(undefined as any)
        const getSpy = spyOn(SessionNs, "get")
        getSpy.mockResolvedValueOnce(shared as any)
        getSpy.mockResolvedValueOnce(unshared as any)

        const commandSpy = spyOn(SessionPrompt, "command").mockResolvedValue({
          info: { id: "msg_command", sessionID: session.id, role: "assistant" },
          parts: [],
        } as any)
        const shellSpy = spyOn(SessionPrompt, "shell").mockResolvedValue({
          info: { id: "msg_shell", sessionID: session.id, role: "assistant" },
          parts: [],
        } as any)
        const app = Server.Default().app

        const shareRes = await app.request(`/session/${session.id}/share`, { method: "POST" })
        expect(shareRes.status).toBe(200)
        expect((await shareRes.json()).share.url).toBe(shared.share!.url)
        expect(shareSpy).toHaveBeenCalledWith(session.id)

        const unshareRes = await app.request(`/session/${session.id}/share`, { method: "DELETE" })
        expect(unshareRes.status).toBe(200)
        expect((await unshareRes.json()).share).toBeUndefined()
        expect(unshareSpy).toHaveBeenCalledWith(session.id)

        const artifactsRes = await app.request(`/session/${session.id}/artifacts`)
        expect(artifactsRes.status).toBe(200)
        expect(Array.isArray(await artifactsRes.json())).toBe(true)

        const commandRes = await app.request(`/session/${session.id}/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: "status",
            arguments: "",
          }),
        })
        expect(commandRes.status).toBe(200)
        expect(commandSpy).toHaveBeenCalled()

        const shellRes = await app.request(`/session/${session.id}/shell`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent: "build",
            command: "pwd",
          }),
        })
        expect(shellRes.status).toBe(200)
        expect(shellSpy).toHaveBeenCalled()

        await svc.remove(session.id)
      },
    })
  })
})
