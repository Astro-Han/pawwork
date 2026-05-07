import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { adapter } from "../../src/server/adapter.node"

describe("node server adapter shutdown", () => {
  test("stop(true) closes upgraded websocket clients", async () => {
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
    const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/ws`)
    const opened = new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        if (event.data === "ready") resolve()
      })
      socket.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true })
    })

    try {
      await opened
      await listener.stop(true)

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(socket.readyState).not.toBe(WebSocket.OPEN)
    } finally {
      socket.close()
      await listener.stop(true)
    }
  })
})
