import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { SessionApi } from "../../src/server/routes/instance/httpapi/groups/session"
import { sessionHandlers } from "../../src/server/routes/instance/httpapi/handlers/session"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  create(input?: Parameters<typeof SessionNs.create>[0]) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  remove(id: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
  updateMessage<T extends MessageV2.Info>(msg: T) {
    return run(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
  },
  updatePart<T extends MessageV2.Part>(part: T) {
    return run(SessionNs.Service.use((svc) => svc.updatePart(part)))
  },
}

afterEach(async () => {
  await Instance.disposeAll()
})

function requestSessionHttpApi(routePath: string, init?: RequestInit) {
  return AppRuntime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const router = yield* HttpRouter.toHttpEffect(
          HttpApiBuilder.layer(SessionApi).pipe(
            Layer.provide(sessionHandlers),
            Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodeHttpPlatform.layer, NodePath.layer, Etag.layer)),
          ),
        )
        const request = HttpServerRequest.fromWeb(new Request(`http://localhost${routePath}`, init))
        const response = yield* router.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.orDie)
        return HttpServerResponse.toWeb(response)
      }),
    ) as Effect.Effect<Response>,
  )
}

async function fill(sessionID: SessionID, count: number, time = (index: number) => Date.now() + index) {
  for (let index = 0; index < count; index++) {
    const messageID = MessageID.ascending()
    await svc.updateMessage({
      id: messageID,
      sessionID,
      role: "user",
      time: { created: time(index) },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as MessageV2.Info)
    await svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID,
      type: "text",
      text: `message-${index}`,
    })
  }
}

describe("session HttpApi routes", () => {
  test("rejects message cursors without a limit like the Hono route", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        try {
          const response = await requestSessionHttpApi(`/session/${session.id}/message?before=bad-cursor`)

          expect(response.status).toBe(400)
        } finally {
          await svc.remove(session.id).catch(() => undefined)
        }
      },
    })
  })

  test("rejects malformed message cursors like the Hono route", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        try {
          const response = await requestSessionHttpApi(`/session/${session.id}/message?limit=2&before=bad-cursor`)

          expect(response.status).toBe(400)
        } finally {
          await svc.remove(session.id).catch(() => undefined)
        }
      },
    })
  })

  test("returns message pagination cursor headers through the HttpApi handler", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        try {
          await fill(session.id, 3)

          const response = await requestSessionHttpApi(`/session/${session.id}/message?limit=2`)

          expect(response.status).toBe(200)
          expect(response.headers.get("x-next-cursor")).toBeTruthy()
          expect(response.headers.get("link")).toContain("rel=\"next\"")
          expect((await response.json()).length).toBe(2)
        } finally {
          await svc.remove(session.id).catch(() => undefined)
        }
      },
    })
  })

  test("maps missing provider models to bad requests like the Hono route", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        try {
          const response = await requestSessionHttpApi(`/session/${session.id}/message`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: { providerID: "missing-provider", modelID: "missing-model" },
              agent: "build",
              parts: [{ type: "text", text: "hello" }],
            }),
          })
          const body = await response.json()

          expect(response.status).toBe(400)
          expect(body.name).toBe("ProviderModelNotFoundError")
        } finally {
          await svc.remove(session.id).catch(() => undefined)
        }
      },
    })
  })
})
