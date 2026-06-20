import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Pty } from "../../src/pty"
import { tmpdir } from "../fixture/fixture"
import { setTimeout as sleep } from "node:timers/promises"

const wait = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await sleep(25)
  }
  if (fn()) return
  throw new Error(`timeout waiting ${ms}ms for pty output`)
}

function pty<A, E>(fn: (svc: Pty.Interface) => Effect.Effect<A, E>) {
  return AppRuntime.runPromise(Pty.Service.use(fn))
}

describe("pty", () => {
  test("does not leak output when websocket objects are reused", async () => {
    await using dir = await tmpdir({ git: true })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const a = await pty((svc) => svc.create({ command: "cat", title: "a" }))
        const b = await pty((svc) => svc.create({ command: "cat", title: "b" }))
        try {
          const outA: string[] = []
          const outB: string[] = []

          const ws = {
            readyState: 1,
            data: { events: { connection: "a" } },
            send: (data: unknown) => {
              outA.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
            },
            close: () => {
              // no-op (simulate abrupt drop)
            },
          }

          // Connect "a" first with ws.
          await pty((svc) => svc.connect(a.id, ws as any))

          // Now "reuse" the same ws object for another connection.
          ws.data = { events: { connection: "b" } }
          ws.send = (data: unknown) => {
            outB.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
          }
          await pty((svc) => svc.connect(b.id, ws as any))

          // Clear connect metadata writes.
          outA.length = 0
          outB.length = 0

          // Output from a must never show up in b.
          await pty((svc) => svc.write(a.id, "AAA\n"))
          await sleep(100)

          expect(outB.join("")).not.toContain("AAA")
        } finally {
          await pty((svc) => svc.remove(a.id))
          await pty((svc) => svc.remove(b.id))
        }
      },
    })
  })

  test("does not leak output when Bun recycles websocket objects before re-connect", async () => {
    await using dir = await tmpdir({ git: true })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const a = await pty((svc) => svc.create({ command: "cat", title: "a" }))
        try {
          const outA: string[] = []
          const outB: string[] = []

          const ws = {
            readyState: 1,
            data: { events: { connection: "a" } },
            send: (data: unknown) => {
              outA.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
            },
            close: () => {
              // no-op (simulate abrupt drop)
            },
          }

          // Connect "a" first.
          await pty((svc) => svc.connect(a.id, ws as any))
          outA.length = 0

          // Simulate Bun reusing the same websocket object for another
          // connection before the next onOpen calls Pty.connect.
          ws.data = { events: { connection: "b" } }
          ws.send = (data: unknown) => {
            outB.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
          }

          await pty((svc) => svc.write(a.id, "AAA\n"))
          await sleep(100)

          expect(outB.join("")).not.toContain("AAA")
        } finally {
          await pty((svc) => svc.remove(a.id))
        }
      },
    })
  })

  test("treats in-place socket data mutation as the same connection", async () => {
    await using dir = await tmpdir({ git: true })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const a = await pty((svc) => svc.create({ command: "cat", title: "a" }))
        try {
          const out: string[] = []

          const ctx = { connId: 1 }
          const ws = {
            readyState: 1,
            data: ctx,
            send: (data: unknown) => {
              out.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
            },
            close: () => {
              // no-op
            },
          }

          await pty((svc) => svc.connect(a.id, ws as any))
          out.length = 0

          // Mutating fields on ws.data should not look like a new
          // connection lifecycle when the object identity stays stable.
          ctx.connId = 2

          await pty((svc) => svc.write(a.id, "AAA\n"))
          await wait(() => out.join("").includes("AAA"))

          expect(out.join("")).toContain("AAA")
        } finally {
          await pty((svc) => svc.remove(a.id))
        }
      },
    })
  })
})
