import { NodeFileSystem } from "@effect/platform-node"
import { beforeEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { AccessToken, AccountID, OrgID, RefreshToken } from "../../src/account"
import { Account } from "../../src/account"
import { AccountRepo } from "../../src/account/repo"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { TurnChange } from "../../src/session/turn-change"
import { SessionTable } from "../../src/session/session.sql"
import { ShareNext } from "../../src/share/share-next"
import { ShareRuntime } from "../../src/share/runtime"
import { Storage } from "../../src/storage/storage"
import { SessionShareTable } from "../../src/share/share.sql"
import { Database, eq } from "../../src/storage/db"
import { AppRuntime } from "../../src/effect/app-runtime"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const env = Layer.mergeAll(
  Session.defaultLayer,
  TurnChange.defaultLayer,
  AccountRepo.layer,
  NodeFileSystem.layer,
  CrossSpawnSpawner.defaultLayer,
)
const it = testEffect(env)
const enabledGate = Layer.succeed(ShareRuntime.CloudShareGate, { isEnabled: () => true })
const turnChange = await AppRuntime.runPromise(TurnChange.Service)
const recordWrite = (input: Parameters<typeof turnChange.recordWrite>[0]) =>
  AppRuntime.runSync(turnChange.recordWrite(input))
const finalize = (input: Parameters<typeof turnChange.finalize>[0]) => AppRuntime.runSync(turnChange.finalize(input))

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const none = HttpClient.make(() => Effect.die("unexpected http call"))

function live(client: HttpClient.HttpClient) {
  const http = Layer.succeed(HttpClient.HttpClient, client)
  return ShareNext.layer.pipe(
    Layer.provide(Bus.layer),
    Layer.provide(Account.layer.pipe(Layer.provide(AccountRepo.layer), Layer.provide(http))),
    Layer.provide(Config.defaultLayer),
    Layer.provide(http),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(TurnChange.defaultLayer),
    Layer.provide(enabledGate),
  )
}

function wired(client: HttpClient.HttpClient) {
  const http = Layer.succeed(HttpClient.HttpClient, client)
  return Layer.mergeAll(
    Bus.layer,
    ShareNext.layer,
    Session.defaultLayer,
    TurnChange.defaultLayer,
    AccountRepo.layer,
    NodeFileSystem.layer,
    CrossSpawnSpawner.defaultLayer,
  ).pipe(
    Layer.provide(Bus.layer),
    Layer.provide(Account.layer.pipe(Layer.provide(AccountRepo.layer), Layer.provide(http))),
    Layer.provide(Config.defaultLayer),
    Layer.provide(http),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(enabledGate),
  )
}

const share = (id: SessionID) =>
  Database.use((db) => db.select().from(SessionShareTable).where(eq(SessionShareTable.session_id, id)).get())

async function makeUser(sessionID: SessionID, suffix: string) {
  const id = MessageID.make(`msg_user_${suffix}`)
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
  } as unknown as MessageV2.Info)
  return id
}

async function makeAssistant(sessionID: SessionID, parentID: MessageID, suffix: string) {
  const id = MessageID.make(`msg_assistant_${suffix}`)
  await Session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    parentID,
    time: { created: Date.now(), completed: Date.now() },
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    mode: "",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as MessageV2.Info)
  return id
}

const seed = (url: string, org?: string) =>
  AccountRepo.use((repo) =>
    repo.persistAccount({
      id: AccountID.make("account-1"),
      email: "user@example.com",
      url,
      accessToken: AccessToken.make("st_test_token"),
      refreshToken: RefreshToken.make("rt_test_token"),
      expiry: Date.now() + 10 * 60_000,
      orgID: org ? Option.some(OrgID.make(org)) : Option.none(),
    }),
  )

beforeEach(async () => {
  await resetDatabase()
})

describe("ShareNext", () => {
  it.live("request uses legacy share API without active org account", () =>
    provideTmpdirInstance(
      () =>
        ShareNext.Service.use((svc) =>
          Effect.gen(function* () {
            const req = yield* svc.request()

            expect(req.api.create).toBe("/api/share")
            expect(req.api.sync("shr_123")).toBe("/api/share/shr_123/sync")
            expect(req.api.remove("shr_123")).toBe("/api/share/shr_123")
            expect(req.api.data("shr_123")).toBe("/api/share/shr_123/data")
            expect(req.baseUrl).toBe("https://legacy-share.example.com")
            expect(req.headers).toEqual({})
          }),
        ).pipe(Effect.provide(live(none))),
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("request uses default URL when no enterprise config", () =>
    provideTmpdirInstance(() =>
      ShareNext.Service.use((svc) =>
        Effect.gen(function* () {
          const req = yield* svc.request()

          expect(req.baseUrl).toBe("https://opncd.ai")
          expect(req.api.create).toBe("/api/share")
          expect(req.headers).toEqual({})
        }),
      ).pipe(Effect.provide(live(none))),
    ),
  )

  it.live("request uses org share API with auth headers when account is active", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* seed("https://control.example.com", "org-1")

        const req = yield* ShareNext.Service.use((svc) => svc.request()).pipe(Effect.provide(live(none)))

        expect(req.api.create).toBe("/api/shares")
        expect(req.api.sync("shr_123")).toBe("/api/shares/shr_123/sync")
        expect(req.api.remove("shr_123")).toBe("/api/shares/shr_123")
        expect(req.api.data("shr_123")).toBe("/api/shares/shr_123/data")
        expect(req.baseUrl).toBe("https://control.example.com")
        expect(req.headers).toEqual({
          authorization: "Bearer st_test_token",
          "x-org-id": "org-1",
        })
      }),
    ),
  )

  it.live("create posts share, persists it, and returns the result", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service.use((svc) => svc.create({ title: "test" }))
          const seen: HttpClientRequest.HttpClientRequest[] = []
          const client = HttpClient.make((req) => {
            seen.push(req)
            if (req.url.endsWith("/api/share")) {
              return Effect.succeed(
                json(req, {
                  id: "shr_abc",
                  url: "https://legacy-share.example.com/share/abc",
                  secret: "sec_123",
                }),
              )
            }
            return Effect.succeed(json(req, { ok: true }))
          })

          const result = yield* ShareNext.Service.use((svc) => svc.create(session.id)).pipe(
            Effect.provide(live(client)),
          )

          expect(result.id).toBe("shr_abc")
          expect(result.url).toBe("https://legacy-share.example.com/share/abc")
          expect(result.secret).toBe("sec_123")

          const row = share(session.id)
          expect(row?.id).toBe("shr_abc")
          expect(row?.url).toBe("https://legacy-share.example.com/share/abc")
          expect(row?.secret).toBe("sec_123")

          expect(seen).toHaveLength(1)
          expect(seen[0].method).toBe("POST")
          expect(seen[0].url).toBe("https://legacy-share.example.com/api/share")
        }),
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("remove deletes the persisted share and calls the delete endpoint", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service.use((svc) => svc.create({ title: "test" }))
          const seen: HttpClientRequest.HttpClientRequest[] = []
          const client = HttpClient.make((req) => {
            seen.push(req)
            if (req.method === "POST") {
              return Effect.succeed(
                json(req, {
                  id: "shr_abc",
                  url: "https://legacy-share.example.com/share/abc",
                  secret: "sec_123",
                }),
              )
            }
            return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 200 })))
          })

          yield* Effect.gen(function* () {
            yield* ShareNext.Service.use((svc) => svc.create(session.id))
            yield* ShareNext.Service.use((svc) => svc.remove(session.id))
          }).pipe(Effect.provide(live(client)))

          expect(share(session.id)).toBeUndefined()
          expect(seen.map((req) => [req.method, req.url])).toEqual([
            ["POST", "https://legacy-share.example.com/api/share"],
            ["DELETE", "https://legacy-share.example.com/api/share/shr_abc"],
          ])
        }),
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("create fails on a non-ok response and does not persist a share", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service.use((svc) => svc.create({ title: "test" }))
        const client = HttpClient.make((req) => Effect.succeed(json(req, { error: "bad" }, 500)))

        const exit = yield* ShareNext.Service.use((svc) => Effect.exit(svc.create(session.id))).pipe(
          Effect.provide(live(client)),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(share(session.id)).toBeUndefined()
      }),
    ),
  )

  it.live("create fails closed and issues no HTTP when CloudShareGate is disabled", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service.use((svc) => svc.create({ title: "test" }))
        // The HttpClient die() ensures any actual HTTP attempt would fail loudly with a defect;
        // the gate must short-circuit before that point.
        const client = none
        const disabledGate = Layer.succeed(ShareRuntime.CloudShareGate, { isEnabled: () => false })

        const exit = yield* ShareNext.Service.use((svc) => Effect.exit(svc.create(session.id))).pipe(
          Effect.provide(
            ShareNext.layer.pipe(
              Layer.provide(Bus.layer),
              Layer.provide(
                Account.layer.pipe(
                  Layer.provide(AccountRepo.layer),
                  Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
                ),
              ),
              Layer.provide(Config.defaultLayer),
              Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
              Layer.provide(Provider.defaultLayer),
              Layer.provide(Session.defaultLayer),
              Layer.provide(TurnChange.defaultLayer),
              Layer.provide(disabledGate),
            ),
          ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(share(session.id)).toBeUndefined()
      }),
    ),
  )

  it.live("ShareNext coalesces rapid diff events into one delayed sync with latest data", () =>
    provideTmpdirInstance(
      () => {
        const seen: Array<{ url: string; body: string }> = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
            seen.push({ url: req.url, body: new TextDecoder().decode(req.body.body) })
          }
          return Effect.succeed(json(req, { ok: true }))
        })

        return Effect.gen(function* () {
          const bus = yield* Bus.Service
          const share = yield* ShareNext.Service
          const session = yield* Session.Service

          const info = yield* session.create({ title: "first" })
          yield* share.init()
          yield* Effect.sleep(50)
          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .insert(SessionShareTable)
                .values({
                  session_id: info.id,
                  id: "shr_abc",
                  url: "https://legacy-share.example.com/share/abc",
                  secret: "sec_123",
                })
                .run(),
            ),
          )

          yield* bus.publish(Session.Event.TurnChangeInvalidated, { sessionID: info.id })
          yield* bus.publish(Session.Event.TurnChangeInvalidated, { sessionID: info.id })
          yield* Effect.sleep(1_250)

          expect(seen).toHaveLength(1)
          expect(seen[0].url).toBe("https://legacy-share.example.com/api/share/shr_abc/sync")

          const body = JSON.parse(seen[0].body) as { secret: string; data: unknown[] }
          expect(body.secret).toBe("sec_123")
          expect(body.data).toHaveLength(1)
          expect(body.data[0]).toEqual({ type: "session_aggregate", data: { kind: "empty", sessionID: info.id } })
        }).pipe(Effect.provide(wired(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("ShareNext session aggregate excludes assistants after a part-level revert cutoff", () =>
    provideTmpdirInstance(
      () => {
        const seen: Array<{ url: string; body: string }> = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
            seen.push({ url: req.url, body: new TextDecoder().decode(req.body.body) })
          }
          return Effect.succeed(json(req, { ok: true }))
        })

        return Effect.gen(function* () {
          const bus = yield* Bus.Service
          const share = yield* ShareNext.Service
          const session = yield* Session.Service

          const info = yield* session.create({ title: "part cutoff share" })
          const userMessageID = yield* Effect.promise(() => makeUser(info.id, "share-part-cutoff"))
          const firstAssistant = yield* Effect.promise(() =>
            makeAssistant(info.id, userMessageID, "share-part-cutoff-a1"),
          )
          const secondAssistant = yield* Effect.promise(() =>
            makeAssistant(info.id, userMessageID, "share-part-cutoff-a2"),
          )

          yield* Effect.sync(() => {
            recordWrite({
              sessionID: info.id,
              messageID: firstAssistant,
              path: "/repo/part-a1.txt",
              before: { exists: false },
              after: { exists: true, content: "a1\n" },
            })
            finalize({ sessionID: info.id, messageID: firstAssistant })
            recordWrite({
              sessionID: info.id,
              messageID: secondAssistant,
              path: "/repo/part-a2.txt",
              before: { exists: false },
              after: { exists: true, content: "a2\n" },
            })
            finalize({ sessionID: info.id, messageID: secondAssistant })
            Database.use((db) =>
              db
                .update(SessionTable)
                .set({ revert: { messageID: firstAssistant, partID: PartID.make("prt_share_part_cutoff") } })
                .where(eq(SessionTable.id, info.id))
                .run(),
            )
          })
          yield* share.init()
          yield* Effect.sleep(50)
          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .insert(SessionShareTable)
                .values({
                  session_id: info.id,
                  id: "shr_abc",
                  url: "https://legacy-share.example.com/share/abc",
                  secret: "sec_123",
                })
                .run(),
            ),
          )

          yield* bus.publish(Session.Event.TurnChangeInvalidated, { sessionID: info.id })
          yield* Effect.sleep(1_250)

          expect(seen).toHaveLength(1)
          const body = JSON.parse(seen[0].body) as { data: Array<{ type: string; data: unknown }> }
          const aggregate = body.data.find((item) => item.type === "session_aggregate")?.data as {
            files?: Array<{ path: string }>
          }
          expect(aggregate.files?.map((file) => file.path)).toEqual(["part-a1.txt"])
        }).pipe(Effect.provide(wired(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("ShareNext redacts sensitive session diff payloads", () =>
    provideTmpdirInstance(
      () => {
        const seen: Array<{ url: string; body: string }> = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
            seen.push({ url: req.url, body: new TextDecoder().decode(req.body.body) })
          }
          return Effect.succeed(json(req, { ok: true }))
        })

        return Effect.gen(function* () {
          const bus = yield* Bus.Service
          const share = yield* ShareNext.Service
          const session = yield* Session.Service

          const info = yield* session.create({ title: "first" })
          yield* share.init()
          yield* Effect.sleep(50)
          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .insert(SessionShareTable)
                .values({
                  session_id: info.id,
                  id: "shr_abc",
                  url: "https://legacy-share.example.com/share/abc",
                  secret: "sec_123",
                })
                .run(),
            ),
          )

          yield* bus.publish(Session.Event.TurnChangeInvalidated, { sessionID: info.id })
          yield* Effect.sleep(1_250)

          expect(seen).toHaveLength(1)
          const body = JSON.parse(seen[0].body) as { data: unknown[] }
          const serialized = JSON.stringify(body)

          expect(serialized).not.toContain("old-secret")
          expect(serialized).not.toContain("new-secret")
          expect(serialized).not.toContain("@@")
          expect(body.data).toEqual([{ type: "session_aggregate", data: { kind: "empty", sessionID: info.id } }])
        }).pipe(Effect.provide(wired(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("ShareNext redacts sensitive diffs embedded in message sync payloads", () =>
    provideTmpdirInstance(
      () => {
        const seen: Array<{ url: string; body: string }> = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
            seen.push({ url: req.url, body: new TextDecoder().decode(req.body.body) })
          }
          return Effect.succeed(json(req, { ok: true }))
        })

        return Effect.gen(function* () {
          const bus = yield* Bus.Service
          const share = yield* ShareNext.Service
          const session = yield* Session.Service

          const info = yield* session.create({ title: "first" })
          yield* share.init()
          yield* Effect.sleep(50)
          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .insert(SessionShareTable)
                .values({
                  session_id: info.id,
                  id: "shr_abc",
                  url: "https://legacy-share.example.com/share/abc",
                  secret: "sec_123",
                })
                .run(),
            ),
          )

          yield* bus.publish(MessageV2.Event.Updated, {
            sessionID: info.id,
            info: {
              id: MessageID.make("msg_sensitive_summary"),
              sessionID: info.id,
              role: "user",
              time: { created: Date.now() },
              agent: "test",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
              tools: {},
              summary: {
                diffs: [
                  {
                    file: ".env",
                    patch: "@@\n-TOKEN=old-secret\n+TOKEN=new-secret\n",
                    additions: 1,
                    deletions: 1,
                    status: "modified",
                  },
                ],
              },
            },
          })
          yield* Effect.sleep(1_250)

          expect(seen).toHaveLength(1)
          const parsed = seen.map((item) => JSON.parse(item.body))
          const body = parsed.find((item) => item.data.some((entry: { type: string }) => entry.type === "message"))
          expect(body).toBeDefined()
          const serialized = JSON.stringify(body)
          expect(serialized).not.toContain("old-secret")
          expect(serialized).not.toContain("new-secret")
          expect(serialized).not.toContain("@@")
          const message = body.data.find((entry: { type: string }) => entry.type === "message")
          expect(message).toMatchObject({
            type: "message",
            data: {
              summary: {},
            },
          })
        }).pipe(Effect.provide(wired(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )
})
