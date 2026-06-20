import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
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
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  touch(sessionID: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.touch(sessionID)))
  },
}

const it = testEffect(SessionNs.defaultLayer)

afterEach(async () => {
  await Instance.disposeAll()
})

describe("session.list", () => {
  test("filters by directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const first = await svc.create({})

        await using other = await tmpdir({ git: true })
        const second = await Instance.provide({
          directory: other.path,
          fn: async () => svc.create({}),
        })

        const sessions = [...svc.list({ directory: tmp.path })]
        const ids = sessions.map((s) => s.id)

        expect(ids).toContain(first.id)
        expect(ids).not.toContain(second.id)
      },
    })
  })

  test("filters by directory with experimental workspaces enabled", async () => {
    await using tmp = await tmpdir({ git: true })
    const subdir = path.join(tmp.path, "packages", "app")
    await fs.mkdir(subdir, { recursive: true })

    const experimental = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
    // @ts-expect-error - Flag is readonly at type level but mutable at runtime for test toggling
    Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const root = await svc.create({ title: "root-session" })
          const nested = await Instance.provide({
            directory: subdir,
            fn: async () => svc.create({ title: "nested-session" }),
          })

          const sessions = [...svc.list({ directory: tmp.path })]
          const ids = sessions.map((s) => s.id)

          expect(ids).toContain(root.id)
          expect(ids).not.toContain(nested.id)
        },
      })
    } finally {
      // @ts-expect-error - Flag is readonly at type level but mutable at runtime for test toggling
      Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = experimental
    }
  })

  test("filters root sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await svc.create({ title: "root-session" })
        const child = await svc.create({ title: "child-session", parentID: root.id })

        const sessions = [...svc.list({ roots: true })]
        const ids = sessions.map((s) => s.id)

        expect(ids).toContain(root.id)
        expect(ids).not.toContain(child.id)
      },
    })
  })

  test("filters by start time", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await svc.create({ title: "new-session" })
        const futureStart = Date.now() + 86400000

        const sessions = [...svc.list({ start: futureStart })]
        expect(sessions.length).toBe(0)
      },
    })
  })

  test("filters by search term", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await svc.create({ title: "unique-search-term-abc" })
        await svc.create({ title: "other-session-xyz" })

        const sessions = [...svc.list({ search: "unique-search" })]
        const titles = sessions.map((s) => s.title)

        expect(titles).toContain("unique-search-term-abc")
        expect(titles).not.toContain("other-session-xyz")
      },
    })
  })

  test("respects limit parameter", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await svc.create({ title: "session-1" })
        await svc.create({ title: "session-2" })
        await svc.create({ title: "session-3" })

        const sessions = [...svc.list({ limit: 2 })]
        expect(sessions.length).toBe(2)
      },
    })
  })

  it.live(
    "keeps default ordering by last update for existing clients",
    Effect.promise(async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const older = await svc.create({ title: "older-session" })
          await new Promise((resolve) => setTimeout(resolve, 5))
          const newer = await svc.create({ title: "newer-session" })
          await svc.touch(older.id)

          const sessions = [...svc.list({ roots: true, limit: 2 })]

          expect(sessions.map((session) => session.id)).toEqual([older.id, newer.id])
        },
      })
    }),
  )

  it.live(
    "orders root sessions by creation time when requested",
    Effect.promise(async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const older = await svc.create({ title: "older-session" })
          await new Promise((resolve) => setTimeout(resolve, 5))
          const newer = await svc.create({ title: "newer-session" })
          await svc.touch(older.id)

          const sessions = [...svc.list({ roots: true, limit: 2, sort: "created" })]

          expect(sessions.map((session) => session.id)).toEqual([newer.id, older.id])
        },
      })
    }),
  )
})
