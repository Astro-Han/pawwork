import { describe, expect, test } from "bun:test"
import { Process } from "../../src/util/process"

describe("node server adapter shutdown", () => {
  test("stop(true) closes upgraded websocket clients", async () => {
    const script = `
      import { adapter } from "./src/server/adapter.node.ts"

      let runtime
      const app = {
        fetch(request, env) {
          if (new URL(request.url).pathname === "/ws") {
            return runtime.upgradeWebSocket(request, env, {
              onOpen(_event, ws) {
                ws.send("ready")
              },
            })
          }
          return new Response(\`main-fetch:\${new URL(request.url).pathname}\`)
        },
      }
      runtime = adapter.create(app)

      const listener = await runtime.listen({ port: 0, hostname: "127.0.0.1" })
      const http = await fetch(\`http://127.0.0.1:\${listener.port}/health\`)
      const httpText = await http.text()
      if (http.status !== 200 || httpText !== "main-fetch:/health") {
        throw new Error(\`HTTP listener did not use main FetchApp: \${http.status} \${httpText}\`)
      }

      const socket = new WebSocket(\`ws://127.0.0.1:\${listener.port}/ws\`)
      const opened = new Promise((resolve, reject) => {
        socket.addEventListener("message", (event) => {
          if (event.data === "ready") resolve()
        })
        socket.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true })
      })

      try {
        await opened
        const closed = new Promise((resolve) => {
          socket.addEventListener("close", resolve, { once: true })
        })
        await listener.stop(true)
        await closed
        if (socket.readyState !== WebSocket.CLOSED) {
          throw new Error("websocket was not closed after stop(true)")
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
    expect(result.stderr.toString()).not.toContain("websocket was not closed after stop(true)")
  }, 10_000)
})
