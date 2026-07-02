import { Log } from "@opencode-ai/core/util/log"
import { Bus } from "@/bus"
import { AppRuntime } from "@/effect/app-runtime"
import { AsyncQueue } from "../../util/queue"
import { createSseResponse } from "../sse"

const log = Log.create({ service: "server" })
const DEFAULT_HEARTBEAT_MS = 10_000

function normalizeHeartbeatMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_HEARTBEAT_MS
}

export function handleInstanceEventStream(request: Request, options: { heartbeatMs?: number } = {}) {
  const heartbeatMs = normalizeHeartbeatMs(options.heartbeatMs)
  log.info("event connected")
  return createSseResponse({
    signal: request.signal,
    start(stream) {
      const q = new AsyncQueue<string | null>()
      let done = false
      let cancelled = false

      q.push(
        JSON.stringify({
          type: "server.connected",
          properties: {},
        }),
      )

      const heartbeat = setInterval(() => {
        q.push(
          JSON.stringify({
            type: "server.heartbeat",
            properties: {},
          }),
        )
      }, heartbeatMs)

      const stop = () => {
        if (done) return
        done = true
        clearInterval(heartbeat)
        unsub()
        q.push(null)
        log.info("event disconnected")
      }

      const unsub = AppRuntime.runSync(
        Bus.Service.use((bus) =>
          bus.subscribeAllCallback((event) => {
            q.push(JSON.stringify(event))
            if (event.type === Bus.InstanceDisposed.type) {
              stop()
            }
          }),
        ),
      )

      void (async () => {
        try {
          for await (const data of q) {
            if (data === null) return
            stream.write({ data })
          }
        } finally {
          if (!cancelled) stream.close()
        }
      })()

      return () => {
        cancelled = true
        stop()
      }
    },
  })
}
