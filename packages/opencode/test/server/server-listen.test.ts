import { describe, expect, test } from "bun:test"
import { Process } from "../../src/util/process"

describe("server listen", () => {
  test("cleans up the bound server when scheduler settle fails", async () => {
    const script = `
      import net from "node:net"
      import { Server } from "./src/server/server.ts"
      import { AutomationScheduler } from "./src/automation/scheduler.ts"
      import { Log } from "@opencode-ai/core/util/log"

      await Log.init({ print: false })

      const listenOnce = (port) =>
        new Promise((resolve, reject) => {
          const server = net.createServer()
          const cleanup = () => {
            server.off("error", reject)
            server.off("listening", ready)
          }
          const ready = () => {
            cleanup()
            const address = server.address()
            server.close(() => resolve(address.port))
          }
          server.once("error", reject)
          server.once("listening", ready)
          server.listen(port, "127.0.0.1")
        })

      const port = await listenOnce(0)
      let stopCalls = 0
      AutomationScheduler.install({
        stop: () => {
          stopCalls += 1
        },
        settleOwner: async () => {
          throw new Error("settle failed")
        },
        reschedule: () => undefined,
        cancel: () => undefined,
        computeNextFireAt: () => null,
      })

      let rejected = false
      let message = ""
      try {
        await Server.listen({ port, hostname: "127.0.0.1" })
      } catch (error) {
        rejected = true
        message = error instanceof Error ? error.message : String(error)
      }

      let portFreed = false
      try {
        await listenOnce(port)
        portFreed = true
      } catch {
        portFreed = false
      }

      console.log(JSON.stringify({ rejected, message, stopCalls, portFreed }))
      process.exit(0)
    `

    const result = await Process.run([process.execPath, "--eval", script], {
      cwd: import.meta.dir + "/../..",
      timeout: 5_000,
    })
    const lastLine = result.stdout.toString().trim().split("\n").at(-1)

    expect(lastLine ? JSON.parse(lastLine) : undefined).toEqual({
      rejected: true,
      message: "settle failed",
      stopCalls: 1,
      portFreed: true,
    })
  }, 10_000)
})
