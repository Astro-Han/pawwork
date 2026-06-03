import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ExternalResult } from "../../src/tool/external-result"
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
  updateMessage<T extends MessageV2.Info>(msg: T) {
    return run(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
  },
  updatePart<T extends MessageV2.Part>(part: T) {
    return run(SessionNs.Service.use((svc) => svc.updatePart(part)))
  },
  messages(input: Parameters<typeof SessionNs.messages>[0]) {
    return run(SessionNs.Service.use((svc) => svc.messages(input)))
  },
}

afterEach(async () => {
  ExternalResult.__resetForTests()
  await Instance.disposeAll()
})

async function withoutWatcher<T>(fn: () => Promise<T>) {
  if (process.platform !== "win32") return fn()
  const prev = process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
  process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
    else process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = prev
  }
}

async function fill(sessionID: SessionID, count: number, time = (i: number) => Date.now() + i) {
  const ids = [] as MessageID[]
  for (let i = 0; i < count; i++) {
    const id = MessageID.ascending()
    ids.push(id)
    await svc.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: time(i) },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as MessageV2.Info)
    await svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: `m${i}`,
    })
  }
  return ids
}

async function createRunningQuestionSession(directory: string, input?: { externalResultReady?: boolean; time?: number }) {
  const session = await svc.create({})
  const userID = MessageID.ascending()
  const time = input?.time ?? Date.now()
  await svc.updateMessage({
    id: userID,
    sessionID: session.id,
    role: "user",
    time: { created: time },
    agent: "user",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)

  const assistantID = MessageID.ascending()
  await svc.updateMessage({
    id: assistantID,
    sessionID: session.id,
    role: "assistant",
    parentID: userID,
    time: { created: time + 1 },
    agent: "build",
    mode: "build",
    path: { cwd: directory, root: directory },
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
  } as unknown as MessageV2.Info)

  const partID = PartID.ascending()
  const callID = "call_stale_question"
  await svc.updatePart({
    id: partID,
    sessionID: session.id,
    messageID: assistantID,
    type: "tool",
    tool: "question",
    callID,
    state: {
      status: "running",
      input: {
        questions: [
          {
            question: "Continue?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      },
      raw: "",
      time: { start: time + 2 },
      metadata: { externalResultReady: input?.externalResultReady ?? true },
    },
  } as unknown as MessageV2.Part)

  return { session, assistantID, partID, callID }
}

function expectToolPart(part: MessageV2.Part | undefined) {
  expect(part?.type).toBe("tool")
  if (part?.type !== "tool") throw new Error("expected tool part")
  return part
}

describe("session messages endpoint", () => {
  test("terminalizes stale running external-result questions in paginated responses", async () => {
    await using tmp = await tmpdir({ git: true })
    ExternalResult.__resetForTests()
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { session, assistantID, partID } = await createRunningQuestionSession(tmp.path)
          const app = Server.Default().app

          const res = await app.request(`/session/${session.id}/message?limit=2`)
          expect(res.status).toBe(200)
          const body = (await res.json()) as MessageV2.WithParts[]
          const part = expectToolPart(body.flatMap((msg) => msg.parts).find((item) => item.id === partID))
          expect(part.state.status).toBe("error")
          if (part.state.status !== "error") throw new Error("expected error state")
          expect(part.state.metadata?.interrupted).toBe(true)
          expect(part.state.metadata?.stale_external_result).toBe(true)

          const persisted = expectToolPart(
            MessageV2.get({ sessionID: session.id, messageID: assistantID }).parts.find(
              (item) => item.id === partID,
            ),
          )
          expect(persisted.state.status).toBe("error")

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("terminalizes stale running external-result questions when fetched from an older cursor page", async () => {
    await using tmp = await tmpdir({ git: true })
    ExternalResult.__resetForTests()
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const time = Date.now()
          const { session, assistantID, partID } = await createRunningQuestionSession(tmp.path, { time })
          await fill(session.id, 3, (i) => time + 10 + i)
          const app = Server.Default().app

          const latest = await app.request(`/session/${session.id}/message?limit=2`)
          expect(latest.status).toBe(200)
          const cursor = latest.headers.get("x-next-cursor")
          expect(cursor).toBeTruthy()

          const older = await app.request(
            `/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor!)}`,
          )
          expect(older.status).toBe(200)
          const body = (await older.json()) as MessageV2.WithParts[]
          const part = expectToolPart(body.flatMap((msg) => msg.parts).find((item) => item.id === partID))
          expect(part.state.status).toBe("error")
          if (part.state.status !== "error") throw new Error("expected error state")
          expect(part.state.metadata?.interrupted).toBe(true)
          expect(part.state.metadata?.stale_external_result).toBe(true)

          const persisted = expectToolPart(
            MessageV2.get({ sessionID: session.id, messageID: assistantID }).parts.find(
              (item) => item.id === partID,
            ),
          )
          expect(persisted.state.status).toBe("error")

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("preserves live pending external-result questions in paginated responses", async () => {
    await using tmp = await tmpdir({ git: true })
    ExternalResult.__resetForTests()
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { session, assistantID, partID, callID } = await createRunningQuestionSession(tmp.path)
          await Effect.runPromise(
            ExternalResult.register({
              sessionID: session.id,
              messageID: assistantID,
              callID,
              inputSnapshot: { questions: ["q1"] },
            }),
          )
          const app = Server.Default().app

          const res = await app.request(`/session/${session.id}/message?limit=2`)
          expect(res.status).toBe(200)
          const body = (await res.json()) as MessageV2.WithParts[]
          const part = expectToolPart(body.flatMap((msg) => msg.parts).find((item) => item.id === partID))
          expect(part.state.status).toBe("running")

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("preserves unready external-result questions in paginated responses", async () => {
    await using tmp = await tmpdir({ git: true })
    ExternalResult.__resetForTests()
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { session, partID } = await createRunningQuestionSession(tmp.path, { externalResultReady: false })
          const app = Server.Default().app

          const res = await app.request(`/session/${session.id}/message?limit=2`)
          expect(res.status).toBe(200)
          const body = (await res.json()) as MessageV2.WithParts[]
          const part = expectToolPart(body.flatMap((msg) => msg.parts).find((item) => item.id === partID))
          expect(part.state.status).toBe("running")

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("returns cursor headers for older pages", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const ids = await fill(session.id, 5)
          const app = Server.Default().app

          const a = await app.request(`/session/${session.id}/message?limit=2`)
          expect(a.status).toBe(200)
          const aBody = (await a.json()) as MessageV2.WithParts[]
          expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
          const cursor = a.headers.get("x-next-cursor")
          expect(cursor).toBeTruthy()
          expect(a.headers.get("link")).toContain('rel="next"')

          const b = await app.request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor!)}`)
          expect(b.status).toBe(200)
          const bBody = (await b.json()) as MessageV2.WithParts[]
          expect(bBody.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("keeps full-history responses when limit is omitted", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const ids = await fill(session.id, 3)
          const app = Server.Default().app

          const res = await app.request(`/session/${session.id}/message`)
          expect(res.status).toBe(200)
          const body = (await res.json()) as MessageV2.WithParts[]
          expect(body.map((item) => item.info.id)).toEqual(ids)

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("rejects invalid cursors and missing sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const app = Server.Default().app

          const bad = await app.request(`/session/${session.id}/message?limit=2&before=bad`)
          expect(bad.status).toBe(400)

          const miss = await app.request(`/session/ses_missing/message?limit=2`)
          expect(miss.status).toBe(404)

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("does not truncate large legacy limit requests", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          await fill(session.id, 520)
          const app = Server.Default().app

          const res = await app.request(`/session/${session.id}/message?limit=510`)
          expect(res.status).toBe(200)
          const body = (await res.json()) as MessageV2.WithParts[]
          expect(body).toHaveLength(510)

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("updates and deletes message parts through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const messageID = MessageID.ascending()
          const partID = PartID.ascending()
          await svc.updateMessage({
            id: messageID,
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info)
          await svc.updatePart({
            id: partID,
            sessionID: session.id,
            messageID,
            type: "text",
            text: "before",
          })
          const app = Server.Default().app

          const update = await app.request(`/session/${session.id}/message/${messageID}/part/${partID}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: partID,
              sessionID: session.id,
              messageID,
              type: "text",
              text: "after",
            }),
          })
          const updated = await update.json()
          expect(update.status).toBe(200)
          expect(updated.text).toBe("after")

          const remove = await app.request(`/session/${session.id}/message/${messageID}/part/${partID}`, {
            method: "DELETE",
          })
          expect(remove.status).toBe(200)
          expect(await remove.json()).toBe(true)
          expect((await svc.messages({ sessionID: session.id }))[0].parts).toHaveLength(0)

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("deletes a message through the route runtime and 404s a missing one", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const [messageID] = await fill(session.id, 1)
          const app = Server.Default().app

          // An existing message still deletes with 200 and is gone afterwards.
          const ok = await app.request(`/session/${session.id}/message/${messageID}`, { method: "DELETE" })
          expect(ok.status).toBe(200)
          expect(await ok.json()).toBe(true)
          expect(await svc.messages({ sessionID: session.id })).toHaveLength(0)

          // The route's declared 404 is now real: deleting a message that does
          // not exist surfaces NotFoundError instead of silently succeeding.
          const miss = await app.request(`/session/${session.id}/message/${MessageID.ascending()}`, {
            method: "DELETE",
          })
          expect(miss.status).toBe(404)
          expect((await miss.json()).name).toBe("NotFoundError")

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("rejects a part update whose body does not match the path with a 400", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const messageID = MessageID.ascending()
          const partID = PartID.ascending()
          await svc.updateMessage({
            id: messageID,
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info)
          await svc.updatePart({
            id: partID,
            sessionID: session.id,
            messageID,
            type: "text",
            text: "before",
          })
          const app = Server.Default().app

          const res = await app.request(`/session/${session.id}/message/${messageID}/part/${partID}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: PartID.ascending(),
              sessionID: session.id,
              messageID,
              type: "text",
              text: "after",
            }),
          })
          expect(res.status).toBe(400)
          const body = await res.json()
          expect(body.success).toBe(false)
          expect(Array.isArray(body.errors)).toBe(true)
          expect(body.errors).toHaveLength(1)
          expect(body.errors[0]?.message).toContain("Part mismatch")

          await svc.remove(session.id)
        },
      }),
    )
  })
})

describe("session.prompt_async error handling", () => {
  test("prompt_async route has error handler for detached prompt call", async () => {
    const src = await Bun.file(new URL("../../src/server/instance/session.ts", import.meta.url)).text()
    const start = src.indexOf('"/:sessionID/prompt_async"')
    const end = src.indexOf('"/:sessionID/command"', start)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)

    const route = src.slice(start, end)
    expect(route).toContain(".catch(")
    expect(route).toContain("Bus.publish(Session.Event.Error")
  })
})
