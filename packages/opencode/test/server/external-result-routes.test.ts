import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { Hono } from "hono"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { ExternalResultRoutes } from "../../src/server/instance/external-result"
import { ExternalResultApi } from "../../src/server/routes/instance/httpapi/groups/external-result"
import { externalResultHandlers } from "../../src/server/routes/instance/httpapi/handlers/external-result"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ExternalResult } from "../../src/tool/external-result"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  ExternalResult.__resetForTests()
  await Instance.disposeAll()
})

describe("external-result routes", () => {
  function app() {
    return new Hono().route("/external-result", ExternalResultRoutes())
  }

  function requestExternalResultHttpApi(routePath: string, init?: RequestInit) {
    return AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(ExternalResultApi).pipe(
              Layer.provide(externalResultHandlers),
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

  test("declares the external-result route group as an HttpApi endpoint", () => {
    const spec = OpenApi.fromApi(ExternalResultApi) as any

    expect(spec.paths["/external-result"]).toHaveProperty("get")
  })

  test("skips stale pending external-result entries through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    ExternalResult.__resetForTests()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Effect.runPromise(
          ExternalResult.register({
            sessionID: SessionID.descending(),
            messageID: MessageID.ascending(),
            callID: "call_stale_external_result_route",
            inputSnapshot: { questions: ["q1"] },
          }),
        )

        const response = await app().request("/external-result")
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual([])
      },
    })
  })

  test("hydrates pending external-result tool calls through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    ExternalResult.__resetForTests()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(Session.Service.use((service) => service.create({})))
        const userID = MessageID.ascending()
        await AppRuntime.runPromise(
          Session.Service.use((service) =>
            service.updateMessage({
              id: userID,
              sessionID: session.id,
              role: "user",
              time: { created: 1 },
              agent: "user",
              model: { providerID: "test", modelID: "test" },
              tools: {},
              mode: "",
            } as unknown as MessageV2.Info),
          ),
        )

        const assistantID = MessageID.ascending()
        await AppRuntime.runPromise(
          Session.Service.use((service) =>
            service.updateMessage({
              id: assistantID,
              sessionID: session.id,
              role: "assistant",
              parentID: userID,
              time: { created: 2 },
              agent: "build",
              mode: "build",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: {
                total: 0,
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              modelID: "test",
              providerID: "test",
            } as unknown as MessageV2.Info),
          ),
        )

        const callID = "call_external_result_route"
        const partID = PartID.ascending()
        await AppRuntime.runPromise(
          Session.Service.use((service) =>
            service.updatePart({
              id: partID,
              sessionID: session.id,
              messageID: assistantID,
              type: "tool",
              tool: "question",
              callID,
              state: {
                status: "running",
                input: { questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] },
                raw: "",
                time: { start: 3 },
                metadata: { externalResultReady: true },
              },
            } as unknown as MessageV2.Part),
          ),
        )

        await Effect.runPromise(
          ExternalResult.register({
            sessionID: session.id,
            messageID: assistantID,
            callID,
            inputSnapshot: { questions: ["q1"] },
          }),
        )

        const response = await app().request("/external-result")
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual([
          expect.objectContaining({
            session: expect.objectContaining({ id: session.id }),
            message: expect.objectContaining({ id: assistantID }),
            part: expect.objectContaining({ id: partID, callID }),
          }),
        ])
      },
    })
  })

  test("skips stale pending external-result entries through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    ExternalResult.__resetForTests()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Effect.runPromise(
          ExternalResult.register({
            sessionID: SessionID.descending(),
            messageID: MessageID.ascending(),
            callID: "call_stale_external_result_httpapi",
            inputSnapshot: { questions: ["q1"] },
          }),
        )

        const response = await requestExternalResultHttpApi("/external-result")
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual([])
      },
    })
  })
})
