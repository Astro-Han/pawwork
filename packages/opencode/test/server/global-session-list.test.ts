import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Project } from "../../src/project/project"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import type { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: Parameters<typeof SessionNs.create>[0]) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  setArchived(input: Parameters<typeof SessionNs.setArchived>[0]) {
    return run(SessionNs.Service.use((svc) => svc.setArchived(input)))
  },
  touch(sessionID: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.touch(sessionID)))
  },
}

const it = testEffect(SessionNs.defaultLayer)

describe("session.listGlobal", () => {
  test("lists sessions across projects with project metadata", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })

    const firstSession = await Instance.provide({
      directory: first.path,
      fn: async () => svc.create({ title: "first-session" }),
    })
    const secondSession = await Instance.provide({
      directory: second.path,
      fn: async () => svc.create({ title: "second-session" }),
    })

    const sessions = [...svc.listGlobal({ limit: 200 })]
    const ids = sessions.map((session) => session.id)

    expect(ids).toContain(firstSession.id)
    expect(ids).toContain(secondSession.id)

    const firstProject = Project.get(firstSession.projectID)
    const secondProject = Project.get(secondSession.projectID)

    const firstItem = sessions.find((session) => session.id === firstSession.id)
    const secondItem = sessions.find((session) => session.id === secondSession.id)

    expect(firstItem?.project?.id).toBe(firstProject?.id)
    expect(firstItem?.project?.worktree).toBe(firstProject?.worktree)
    expect(secondItem?.project?.id).toBe(secondProject?.id)
    expect(secondItem?.project?.worktree).toBe(secondProject?.worktree)
  })

  test("excludes archived sessions by default", async () => {
    await using tmp = await tmpdir({ git: true })

    const archived = await Instance.provide({
      directory: tmp.path,
      fn: async () => svc.create({ title: "archived-session" }),
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => svc.setArchived({ sessionID: archived.id, time: Date.now() }),
    })

    const sessions = [...svc.listGlobal({ limit: 200 })]
    const ids = sessions.map((session) => session.id)

    expect(ids).not.toContain(archived.id)

    const allSessions = [...svc.listGlobal({ limit: 200, archived: true })]
    const allIds = allSessions.map((session) => session.id)

    expect(allIds).toContain(archived.id)
  })

  it.live(
    "supports cursor pagination",
    Effect.promise(async () => {
      await using tmp = await tmpdir({ git: true })

      const first = await Instance.provide({
        directory: tmp.path,
        fn: async () => svc.create({ title: "page-one" }),
      })
      await new Promise((resolve) => setTimeout(resolve, 5))
      const second = await Instance.provide({
        directory: tmp.path,
        fn: async () => svc.create({ title: "page-two" }),
      })

      const page = [...svc.listGlobal({ directory: tmp.path, limit: 1 })]
      expect(page.length).toBe(1)
      expect(page[0].id).toBe(second.id)

      const next = [...svc.listGlobal({ directory: tmp.path, limit: 10, cursor: page[0].time.updated })]
      const ids = next.map((session) => session.id)

      expect(ids).toContain(first.id)
      expect(ids).not.toContain(second.id)
    }),
  )

  it.live(
    "keeps default global ordering by last update for existing clients",
    Effect.promise(async () => {
      await using tmp = await tmpdir({ git: true })

      const older = await Instance.provide({
        directory: tmp.path,
        fn: async () => svc.create({ title: "older-session" }),
      })
      await new Promise((resolve) => setTimeout(resolve, 5))
      const newer = await Instance.provide({
        directory: tmp.path,
        fn: async () => svc.create({ title: "newer-session" }),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => svc.touch(older.id),
      })

      const sessions = [...svc.listGlobal({ directory: tmp.path, limit: 2 })]

      expect(sessions.map((session) => session.id)).toEqual([older.id, newer.id])
    }),
  )

  it.live(
    "orders global sessions by creation time when requested",
    Effect.promise(async () => {
      await using tmp = await tmpdir({ git: true })

      const older = await Instance.provide({
        directory: tmp.path,
        fn: async () => svc.create({ title: "older-session" }),
      })
      await new Promise((resolve) => setTimeout(resolve, 5))
      const newer = await Instance.provide({
        directory: tmp.path,
        fn: async () => svc.create({ title: "newer-session" }),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => svc.touch(older.id),
      })

      const sessions = [...svc.listGlobal({ directory: tmp.path, limit: 2, sort: "created" })]

      expect(sessions.map((session) => session.id)).toEqual([newer.id, older.id])
    }),
  )

  test("paginates created-order sessions that share the same creation time", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalNow = Date.now
    Date.now = () => 1_000
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await svc.create({ title: "same-time-a" })
          await svc.create({ title: "same-time-b" })
        },
      })
    } finally {
      Date.now = originalNow
    }

    const page = [...svc.listGlobal({ directory: tmp.path, limit: 1, sort: "created" })]
    expect(page.length).toBe(1)

    const next = [
      ...svc.listGlobal({
        directory: tmp.path,
        limit: 10,
        sort: "created",
        cursor: { created: page[0].time.created, id: page[0].id },
      }),
    ]

    expect(next.length).toBe(1)
    expect(next[0].time.created).toBe(page[0].time.created)
    expect(page[0].id.localeCompare(next[0].id)).toBeLessThan(0)
  })

  it.live(
    "session route orders by creation time when requested",
    Effect.promise(async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const older = await svc.create({ title: "route-older-session" })
          await new Promise((resolve) => setTimeout(resolve, 5))
          const newer = await svc.create({ title: "route-newer-session" })
          await svc.touch(older.id)

          const app = Server.Default().app
          const response = await app.request(
            `/session?directory=${encodeURIComponent(tmp.path)}&roots=true&limit=2&sort=created`,
          )
          expect(response.status).toBe(200)
          const body = (await response.json()) as SessionNs.Info[]

          expect(body.map((session) => session.id)).toEqual([newer.id, older.id])
        },
      })
    }),
  )

  test("experimental route round-trips created-order cursor", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalNow = Date.now
    Date.now = () => 1_000
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await svc.create({ title: "route-same-time-a" })
          await svc.create({ title: "route-same-time-b" })
        },
      })
    } finally {
      Date.now = originalNow
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const first = await app.request(
          `/experimental/session?directory=${encodeURIComponent(tmp.path)}&roots=true&limit=1&sort=created`,
        )
        expect(first.status).toBe(200)
        const cursor = first.headers.get("x-next-cursor")
        expect(cursor).toBeTruthy()
        const firstBody = (await first.json()) as SessionNs.GlobalInfo[]
        expect(firstBody).toHaveLength(1)

        const second = await app.request(
          `/experimental/session?directory=${encodeURIComponent(tmp.path)}&roots=true&limit=10&sort=created&cursor=${encodeURIComponent(cursor!)}`,
        )
        expect(second.status).toBe(200)
        const secondBody = (await second.json()) as SessionNs.GlobalInfo[]
        expect(secondBody).toHaveLength(1)
        expect(secondBody[0].id).not.toBe(firstBody[0].id)
      },
    })
  })

  test("experimental route ignores malformed created-order cursor", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await svc.create({ title: "malformed-cursor" })

        const app = Server.Default().app
        const response = await app.request(
          `/experimental/session?directory=${encodeURIComponent(tmp.path)}&roots=true&limit=10&sort=created&cursor=abc`,
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as SessionNs.GlobalInfo[]

        expect(body.map((session) => session.title)).toContain("malformed-cursor")
      },
    })
  })

  test("experimental route ignores empty updated cursor", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await svc.create({ title: "empty-updated-cursor" })

        const app = Server.Default().app
        const response = await app.request(
          `/experimental/session?directory=${encodeURIComponent(tmp.path)}&roots=true&limit=10&cursor=`,
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as SessionNs.GlobalInfo[]

        expect(body.map((session) => session.title)).toContain("empty-updated-cursor")
      },
    })
  })

  test("experimental route ignores undefined-string updated cursor", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await svc.create({ title: "undefined-updated-cursor" })

        const app = Server.Default().app
        const response = await app.request(
          `/experimental/session?directory=${encodeURIComponent(tmp.path)}&roots=true&limit=10&cursor=undefined`,
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as SessionNs.GlobalInfo[]

        expect(body.map((session) => session.title)).toContain("undefined-updated-cursor")
      },
    })
  })

  test("experimental route ignores numeric cursor for created-order pagination", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalNow = Date.now
    Date.now = () => 1_000
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await svc.create({ title: "numeric-created-cursor-a" })
          await svc.create({ title: "numeric-created-cursor-b" })
        },
      })
    } finally {
      Date.now = originalNow
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const response = await app.request(
          `/experimental/session?directory=${encodeURIComponent(tmp.path)}&roots=true&limit=10&sort=created&cursor=1000`,
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as SessionNs.GlobalInfo[]

        expect(body.map((session) => session.title).sort()).toEqual([
          "numeric-created-cursor-a",
          "numeric-created-cursor-b",
        ])
      },
    })
  })

  it.live(
    "experimental route keeps default numeric updated cursor",
    Effect.promise(async () => {
      await using tmp = await tmpdir({ git: true })
      const older = await Instance.provide({
        directory: tmp.path,
        fn: async () => svc.create({ title: "route-older" }),
      })
      await new Promise((resolve) => setTimeout(resolve, 5))
      await Instance.provide({
        directory: tmp.path,
        fn: async () => svc.create({ title: "route-newer" }),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => svc.touch(older.id),
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const app = Server.Default().app
          const first = await app.request(
            `/experimental/session?directory=${encodeURIComponent(tmp.path)}&roots=true&limit=1`,
          )
          expect(first.status).toBe(200)
          const cursor = first.headers.get("x-next-cursor")
          expect(cursor).toBeTruthy()
          expect(Number.isFinite(Number(cursor))).toBe(true)
        },
      })
    }),
  )
})
