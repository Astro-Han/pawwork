import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { Runner, type InterruptMeta, type Runner as RunnerInstance } from "../../src/effect/runner"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import { SessionRunState } from "../../src/session/run-state"
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
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/abort`, { method: "POST" })

        expect(res.status).toBe(200)
        expect(await res.json()).toBe(true)

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
        let cancelMeta: InterruptMeta | undefined
        let resolveEntered!: () => void
        let resolveRelease!: () => void
        const entered = new Promise<void>((resolve) => {
          resolveEntered = resolve
        })
        const release = new Promise<void>((resolve) => {
          resolveRelease = resolve
        })
        spyOn(Runner, "make").mockImplementation(() => {
          const fake = {
            get state() {
              return { _tag: "Idle" } as const
            },
            get busy() {
              return false
            },
            ensureRunning: () => Effect.die(new Error("unexpected ensureRunning")),
            startShell: () =>
              Effect.promise(async () => {
                resolveEntered()
                await release
                return {} as never
              }),
            cancel: Effect.sync(() => {
              cancelMeta = undefined
            }),
            cancelWith: (meta?: InterruptMeta) =>
              Effect.sync(() => {
                cancelMeta = meta
              }),
          } satisfies RunnerInstance<never>
          return fake as never
        })
        const shell = AppRuntime.runPromise(
          Effect.gen(function* () {
            const run = yield* SessionRunState.Service
            return yield* run.startShell(
              session.id,
              () => Effect.sync(() => ({}) as never),
              Effect.sync(() => ({}) as never),
            )
          }),
        )
        await entered
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/abort?source=renderer.stopButton`, {
          method: "POST",
          headers: { "x-opencode-directory": tmp.path },
        })

        expect(res.status).toBe(200)
        expect(await res.json()).toBe(true)
        expect(cancelMeta).toMatchObject({
          source: "renderer.stopButton",
          reason: "cancel",
        })

        resolveRelease()
        await shell.catch(() => undefined)
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
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/abort?source=renderer%20stop`, { method: "POST" })

        expect(res.status).toBe(400)

        await svc.remove(session.id)
      },
    })
  })
})
