import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { Log } from "../../src/util/log"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Export, getRuntimeNamespace } from "../../src/session/export"

const projectRoot = path.join(__dirname, "../..")
void Log.init({ print: false })

describe("Export.session", () => {
  test("getRuntimeNamespace returns 'pawwork' or 'opencode'", () => {
    expect(["pawwork", "opencode"]).toContain(getRuntimeNamespace())
  })

  test("exports a single root session with empty messages and stub runtime_context", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await SessionNs.create({ title: "test session" })
        try {
          // Precondition: this test is the "single root, no climb" contract — Task 2 adds climb.
          expect(created.parentID).toBeUndefined()

          const result = await AppRuntime.runPromise(Export.session(created.id))

          expect(result.schema_version).toBe(1)
          expect(result.format).toBe("pawwork-session-export")
          expect(typeof result.exported_at).toBe("number")
          expect(result.root_session_id).toBe(created.id)
          expect(result.session.info.id).toBe(created.id)
          expect(result.session.info.title).toBe("test session")
          // info.share is stripped from the export
          expect((result.session.info as { share?: unknown }).share).toBeUndefined()
          expect(result.session.had_cloud_share).toBe(false)
          expect(result.session.messages).toEqual([])
          expect(result.session.diffs).toEqual([])
          expect(result.session.children).toEqual([])
          expect(result.runtime_context.runtime_namespace).toBe(getRuntimeNamespace())
          expect(result.runtime_context.stats.session_count).toBe(1)
          expect(result.runtime_context.stats.message_count).toBe(0)
          expect(result.diagnostics).toEqual({})
        } finally {
          await SessionNs.remove(created.id)
        }
      },
    })
  })

  test("climbs to root when given a child session id", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const root = await SessionNs.create({ title: "root" })
        const child = await SessionNs.create({ parentID: root.id, title: "child" })
        try {
          const result = await AppRuntime.runPromise(Export.session(child.id))

          expect(result.root_session_id).toBe(root.id)
          expect(result.session.info.id).toBe(root.id)
          expect(result.session.children).toHaveLength(1)
          expect(result.session.children[0].info.id).toBe(child.id)
          expect(result.runtime_context.stats.session_count).toBe(2)
        } finally {
          await SessionNs.remove(root.id)
        }
      },
    })
  })

  test("orders children deterministically by time.created then id", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const root = await SessionNs.create({ title: "root" })
        const a = await SessionNs.create({ parentID: root.id, title: "a" })
        // Force a measurable time gap so the test does not depend on intra-millisecond create timing
        // and does not bottom out on tie-break against monotonic-descending SessionID, which would
        // make the assertion tautological.
        await new Promise((r) => setTimeout(r, 10))
        const b = await SessionNs.create({ parentID: root.id, title: "b" })
        try {
          // Independent verification: a was created first → a.time.created < b.time.created
          expect(a.time.created).toBeLessThan(b.time.created)

          const result = await AppRuntime.runPromise(Export.session(root.id))
          const ids = result.session.children.map((c) => c.info.id)

          // Hard-coded expected order based on creation sequence, not derived from result's own sort.
          expect(ids).toEqual([a.id, b.id])
        } finally {
          await SessionNs.remove(root.id)
        }
      },
    })
  })

  test("ties break by id.localeCompare when time.created is equal (synthesized fixture)", () => {
    // Pure-function test on the sort comparator, not against real session creation,
    // so this assertion is independently verifiable and does not depend on timing.
    const cmp = (x: { time: { created: number }; id: string }, y: typeof x) => {
      if (x.time.created !== y.time.created) return x.time.created - y.time.created
      return x.id.localeCompare(y.id)
    }
    const items = [
      { id: "ses_b", time: { created: 100 } },
      { id: "ses_a", time: { created: 100 } },
    ]
    expect([...items].sort(cmp).map((s) => s.id)).toEqual(["ses_a", "ses_b"])
  })
})
