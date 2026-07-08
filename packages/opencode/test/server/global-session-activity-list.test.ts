import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { SyncEvent } from "../../src/sync"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  updateMessage(input: MessageV2.Info) {
    return run(SessionNs.Service.use((svc) => svc.updateMessage(input)))
  },
  updatePart(input: MessageV2.Part) {
    return run(SessionNs.Service.use((svc) => svc.updatePart(input)))
  },
}

describe("session.listGlobal activity order", () => {
  const patchSessionTime = (sessionID: SessionID, time: number) =>
    SyncEvent.run(SessionNs.Event.Updated, { sessionID, info: { time: { created: time, updated: time } } }, { publish: false })

  const touchSessionAt = (sessionID: SessionID, time: number) =>
    SyncEvent.run(SessionNs.Event.Updated, { sessionID, info: { time: { updated: time } } }, { publish: false })

  const createSessionAt = (directory: string, time: number, input?: SessionNs.CreateInput) =>
    Instance.provide({
      directory,
      fn: async () => {
        const session = await svc.create(input)
        patchSessionTime(session.id, time)
        return { ...session, time: { created: time, updated: time } }
      },
    })

  const userMessage = (sessionID: SessionID, created: number) =>
    svc.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created },
      agent: "build",
      model: {
        providerID: ProviderID.openai,
        modelID: "test-model" as ModelID,
      },
    })

  const assistantMessage = (sessionID: SessionID, created: number, parentID: MessageID = MessageID.ascending()) =>
    svc.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
      time: { created },
      parentID,
      modelID: "test-model" as ModelID,
      providerID: ProviderID.openai,
      mode: "build",
      agent: "build",
      path: {
        cwd: "/tmp",
        root: "/tmp",
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
    })

  const compactionMessage = async (sessionID: SessionID, created: number) => {
    const message = await userMessage(sessionID, created)
    await svc.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID,
      type: "compaction",
      auto: true,
    })
    return message
  }

  const syntheticContinueMessage = async (sessionID: SessionID, created: number) => {
    const message = await userMessage(sessionID, created)
    await svc.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID,
      type: "text",
      text: "Continue if you have next steps.",
      synthetic: true,
      metadata: { compaction_continue: true },
      time: { start: created, end: created },
    })
    return message
  }

  const userMessageWithSyntheticReminder = async (sessionID: SessionID, created: number) => {
    const message = await userMessage(sessionID, created)
    await svc.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID,
      type: "text",
      text: "Real user prompt",
      time: { start: created, end: created },
    })
    await svc.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID,
      type: "text",
      text: "Plan mode is active.",
      synthetic: true,
      time: { start: created, end: created },
    })
    return message
  }

  test("orders global sessions by latest user message activity when requested", async () => {
    await using tmp = await tmpdir({ git: true })
    const oldActive = await createSessionAt(tmp.path, 1_000, { title: "old-active" })
    const newerFallback = await createSessionAt(tmp.path, 2_000, { title: "newer-fallback" })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => userMessage(oldActive.id, 4_000),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => touchSessionAt(newerFallback.id, 3_000),
    })

    const sessions = [
      ...svc.listGlobal({
        directory: tmp.path,
        limit: 2,
        sort: "activity" as never,
      }),
    ]

    expect(sessions.map((session) => session.id)).toEqual([oldActive.id, newerFallback.id])
    expect(sessions[0]).toMatchObject({
      activityAt: 4_000,
      lastUserMessageAt: 4_000,
    })
    expect(sessions[1]).toMatchObject({
      activityAt: 2_000,
    })
    expect(Object.hasOwn(sessions[1] as Record<string, unknown>, "lastUserMessageAt")).toBe(false)
  })

  test("does not promote activity order from assistant messages or session updates", async () => {
    await using tmp = await tmpdir({ git: true })
    const oldAssistantOnly = await createSessionAt(tmp.path, 1_000, { title: "old-assistant-only" })
    const newerFallback = await createSessionAt(tmp.path, 2_000, { title: "newer-fallback" })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await assistantMessage(oldAssistantOnly.id, 5_000)
        touchSessionAt(oldAssistantOnly.id, 3_000)
      },
    })

    const sessions = [
      ...svc.listGlobal({
        directory: tmp.path,
        limit: 2,
        sort: "activity" as never,
      }),
    ]

    expect(sessions.map((session) => session.id)).toEqual([newerFallback.id, oldAssistantOnly.id])
    expect(sessions.map((session) => (session as typeof session & { activityAt?: number }).activityAt)).toEqual([
      2_000,
      1_000,
    ])
  })

  test("does not promote activity order from compaction or synthetic user messages", async () => {
    await using tmp = await tmpdir({ git: true })
    const compactionOnly = await createSessionAt(tmp.path, 1_000, { title: "compaction-only" })
    const syntheticOnly = await createSessionAt(tmp.path, 2_000, { title: "synthetic-only" })
    const realUser = await createSessionAt(tmp.path, 3_000, { title: "real-user" })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await compactionMessage(compactionOnly.id, 6_000)
        await syntheticContinueMessage(syntheticOnly.id, 5_000)
        await userMessage(realUser.id, 4_000)
      },
    })

    const sessions = [
      ...svc.listGlobal({
        directory: tmp.path,
        limit: 3,
        sort: "activity" as never,
      }),
    ]

    expect(sessions.map((session) => session.id)).toEqual([realUser.id, syntheticOnly.id, compactionOnly.id])
    expect(sessions.map((session) => (session as typeof session & { activityAt?: number }).activityAt)).toEqual([
      4_000,
      2_000,
      1_000,
    ])
    expect(sessions.map((session) => Object.hasOwn(session as Record<string, unknown>, "lastUserMessageAt"))).toEqual([
      true,
      false,
      false,
    ])
  })

  test("keeps real user activity when the message also has synthetic reminder parts", async () => {
    await using tmp = await tmpdir({ git: true })
    const oldMixedUser = await createSessionAt(tmp.path, 1_000, { title: "old-mixed-user" })
    const newerFallback = await createSessionAt(tmp.path, 2_000, { title: "newer-fallback" })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => userMessageWithSyntheticReminder(oldMixedUser.id, 4_000),
    })

    const sessions = [
      ...svc.listGlobal({
        directory: tmp.path,
        limit: 2,
        sort: "activity" as never,
      }),
    ]

    expect(sessions.map((session) => session.id)).toEqual([oldMixedUser.id, newerFallback.id])
    expect(sessions[0]).toMatchObject({
      activityAt: 4_000,
      lastUserMessageAt: 4_000,
    })
    expect(sessions[1]).toMatchObject({
      activityAt: 2_000,
    })
  })

  test("paginates activity-order sessions that share the same activity time", async () => {
    await using tmp = await tmpdir({ git: true })
    await createSessionAt(tmp.path, 1_000, { title: "same-activity-a" })
    await createSessionAt(tmp.path, 1_000, { title: "same-activity-b" })

    const page = [
      ...svc.listGlobal({
        directory: tmp.path,
        limit: 1,
        sort: "activity" as never,
      }),
    ]
    expect(page).toHaveLength(1)

    const next = [
      ...svc.listGlobal({
        directory: tmp.path,
        limit: 10,
        sort: "activity" as never,
        cursor: {
          activityAt: (page[0] as typeof page[0] & { activityAt: number }).activityAt,
          id: page[0].id,
        } as never,
      }),
    ]

    expect(next).toHaveLength(1)
    expect((next[0] as typeof next[0] & { activityAt: number }).activityAt).toBe(
      (page[0] as typeof page[0] & { activityAt: number }).activityAt,
    )
    expect(page[0].id.localeCompare(next[0].id)).toBeLessThan(0)
  })

  test("experimental route round-trips activity-order cursor", async () => {
    await using tmp = await tmpdir({ git: true })
    await createSessionAt(tmp.path, 1_000, { title: "route-same-activity-a" })
    await createSessionAt(tmp.path, 1_000, { title: "route-same-activity-b" })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const first = await app.request(
          `/experimental/session?directory=${encodeURIComponent(tmp.path)}&roots=true&limit=1&sort=activity`,
        )
        expect(first.status).toBe(200)
        const cursor = first.headers.get("x-next-cursor")
        expect(cursor).toBeTruthy()
        expect(first.headers.get("Access-Control-Expose-Headers")).toContain("X-Next-Cursor")
        const firstBody = (await first.json()) as SessionNs.GlobalInfo[]
        expect(firstBody).toHaveLength(1)
        expect(firstBody[0].activityAt).toBe(1_000)

        const second = await app.request(
          `/experimental/session?directory=${encodeURIComponent(tmp.path)}&roots=true&limit=10&sort=activity&cursor=${encodeURIComponent(cursor!)}`,
        )
        expect(second.status).toBe(200)
        const secondBody = (await second.json()) as SessionNs.GlobalInfo[]
        expect(secondBody).toHaveLength(1)
        expect(secondBody[0].id).not.toBe(firstBody[0].id)
        expect(secondBody[0].activityAt).toBe(1_000)
      },
    })
  })
})
