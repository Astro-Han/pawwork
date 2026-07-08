import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { tmpdir } from "../fixture/fixture"
import z from "zod"
import { Instance } from "../../src/project/instance"
import { SyncEvent } from "../../src/sync"
import { Database } from "../../src/storage/db"
import { EventTable } from "../../src/sync/event.sql"
import { Identifier } from "../../src/id/id"
import { Flag } from "@opencode-ai/core/flag/flag"
import { initProjectors } from "../../src/server/projectors"
import { testEffect } from "../lib/effect"
import { GlobalBus } from "../../src/bus/global"

const original = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const syncIt = testEffect(SyncEvent.defaultLayer)

beforeEach(() => {
  Database.close()

  // @ts-expect-error don't do this normally, but it works
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
})

afterEach(() => {
  // @ts-expect-error don't do this normally, but it works
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = original
})

function withInstance(fn: () => void | Promise<void>) {
  return async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await fn()
      },
    })
  }
}

describe("SyncEvent", () => {
  function setup() {
    SyncEvent.reset()

    const Created = SyncEvent.define({
      type: "item.created",
      version: 1,
      aggregate: "id",
      schema: z.object({ id: z.string(), name: z.string() }),
    })
    const Sent = SyncEvent.define({
      type: "item.sent",
      version: 1,
      aggregate: "item_id",
      schema: z.object({ item_id: z.string(), to: z.string() }),
    })

    SyncEvent.init({
      projectors: [SyncEvent.project(Created, () => {}), SyncEvent.project(Sent, () => {})],
    })

    return { Created, Sent }
  }

  afterAll(() => {
    SyncEvent.reset()
    initProjectors()
  })

  describe("run", () => {
    test(
      "inserts event row",
      withInstance(() => {
        const { Created } = setup()
        SyncEvent.run(Created, { id: "evt_1", name: "first" })
        const rows = Database.use((db) => db.select().from(EventTable).all())
        expect(rows).toHaveLength(1)
        expect(rows[0].type).toBe("item.created.1")
        expect(rows[0].aggregate_id).toBe("evt_1")
      }),
    )

    test(
      "increments seq per aggregate",
      withInstance(() => {
        const { Created } = setup()
        SyncEvent.run(Created, { id: "evt_1", name: "first" })
        SyncEvent.run(Created, { id: "evt_1", name: "second" })
        const rows = Database.use((db) => db.select().from(EventTable).all())
        expect(rows).toHaveLength(2)
        expect(rows[1].seq).toBe(rows[0].seq + 1)
      }),
    )

    test(
      "uses custom aggregate field from agg()",
      withInstance(() => {
        const { Sent } = setup()
        SyncEvent.run(Sent, { item_id: "evt_1", to: "james" })
        const rows = Database.use((db) => db.select().from(EventTable).all())
        expect(rows).toHaveLength(1)
        expect(rows[0].aggregate_id).toBe("evt_1")
      }),
    )

    test(
      "emits events",
      withInstance(async () => {
        const { Created } = setup()
        const events: Array<{
          type: string
          properties: { id: string; name: string }
        }> = []
        const received = new Promise<void>((resolve) => {
          const handler = (event: { payload: { type: string; properties: { id: string; name: string } } }) => {
            GlobalBus.off("event", handler)
            events.push(event.payload)
            resolve()
          }
          GlobalBus.on("event", handler)
        })

        SyncEvent.run(Created, { id: "evt_1", name: "test" })

        await received
        expect(events).toHaveLength(1)
        expect(events[0]).toEqual({
          type: "item.created",
          properties: {
            id: "evt_1",
            name: "test",
          },
        })
      }),
    )
  })

  describe("replay", () => {
    syncIt.effect(
      "returns a typed Effect failure for unknown event types",
      Effect.gen(function* () {
        setup()

        const exit = yield*
          SyncEvent.Service.use((sync) =>
            sync.replay({
              id: "evt_1",
              type: "unknown.event.1",
              seq: 0,
              aggregateID: "x",
              data: {},
            }),
          ).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        const failure = Cause.squash(exit.cause)
        const syncError = failure as SyncEvent.SyncEventError
        expect(syncError).toBeInstanceOf(SyncEvent.SyncEventError)
        expect(syncError.reason).toBe("unknown-event-type")
        expect(syncError.message).toContain("Unknown event type")
      }),
    )

    test(
      "inserts event from external payload",
      withInstance(() => {
        const id = Identifier.descending("message")
        SyncEvent.replay({
          id: "evt_1",
          type: "item.created.1",
          seq: 0,
          aggregateID: id,
          data: { id, name: "replayed" },
        })
        const rows = Database.use((db) => db.select().from(EventTable).all())
        expect(rows).toHaveLength(1)
        expect(rows[0].aggregate_id).toBe(id)
      }),
    )

    test(
      "throws on sequence mismatch",
      withInstance(() => {
        const id = Identifier.descending("message")
        SyncEvent.replay({
          id: "evt_1",
          type: "item.created.1",
          seq: 0,
          aggregateID: id,
          data: { id, name: "first" },
        })
        expect(() =>
          SyncEvent.replay({
            id: "evt_1",
            type: "item.created.1",
            seq: 5,
            aggregateID: id,
            data: { id, name: "bad" },
          }),
        ).toThrow(/Sequence mismatch/)
      }),
    )

    test(
      "throws on unknown event type",
      withInstance(() => {
        expect(() =>
          SyncEvent.replay({
            id: "evt_1",
            type: "unknown.event.1",
            seq: 0,
            aggregateID: "x",
            data: {},
          }),
        ).toThrow(/Unknown event type/)
      }),
    )
  })
})
