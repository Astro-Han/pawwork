import { describe, expect, test } from "bun:test"
import { Process } from "../../src/util/process"

describe("node server adapter shutdown", () => {
  test("stop(true) closes upgraded websocket clients", async () => {
    const script = `
      import { Hono } from "hono"
      import { adapter } from "./src/server/adapter.node.ts"

      const app = new Hono()
      const runtime = adapter.create(app)

      app.get(
        "/ws",
        runtime.upgradeWebSocket(() => ({
          onOpen(_event, ws) {
            ws.send("ready")
          },
        })),
      )

      const listener = await runtime.listen({ port: 0, hostname: "127.0.0.1" })
      const socket = new WebSocket(\`ws://127.0.0.1:\${listener.port}/ws\`)
      const opened = new Promise((resolve, reject) => {
        socket.addEventListener("message", (event) => {
          if (event.data === "ready") resolve()
        })
        socket.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true })
      })

      try {
        await opened
        await listener.stop(true)
        await new Promise((resolve) => setTimeout(resolve, 50))
        if (socket.readyState === WebSocket.OPEN) {
          throw new Error("websocket remained open after stop(true)")
        }
      } finally {
        socket.close()
        await listener.stop(true)
      }
    `

    const result = await Process.run([process.execPath, "--conditions=node", "--eval", script], {
      cwd: import.meta.dir + "/../..",
      nothrow: true,
      timeout: 5_000,
    })

    expect(result.code).toBe(0)
    expect(result.stderr.toString()).not.toContain("websocket remained open after stop(true)")
  }, 10_000)
})
