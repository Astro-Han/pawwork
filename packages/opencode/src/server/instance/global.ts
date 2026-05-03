import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Effect } from "effect"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { GlobalBus } from "@/bus/global"
import { AppRuntime } from "@/effect/app-runtime"
import { AsyncQueue } from "@/util/queue"
import { Instance } from "../../project/instance"
import { Installation } from "@/installation"
import { Log } from "@opencode-ai/core/util/log"
import { lazy } from "../../util/lazy"
import { Config } from "../../config/config"
import { errors } from "../error"
import { EventReplayStore, type GlobalEventEnvelope, type ReplayRecord } from "../event-replay"

const log = Log.create({ service: "server" })

export const GlobalDisposedEvent = BusEvent.define("global.disposed", z.object({}))

type SsePacket = {
  id?: string
  data: string
  replaySeq?: number
}

export type GlobalEventReplayPacket = SsePacket

function packetForEnvelope(envelope: GlobalEventEnvelope, id?: string): SsePacket {
  return {
    id,
    data: JSON.stringify(envelope),
  }
}

function packetForRecord(record: ReplayRecord): SsePacket {
  return {
    id: record.id,
    replaySeq: record.seq,
    data: JSON.stringify(record.envelope),
  }
}

export function createGlobalEventReplayBridge(input?: { replayStore?: EventReplayStore }) {
  const replayStore = input?.replayStore ?? new EventReplayStore()
  const listeners = new Set<(packet: GlobalEventReplayPacket) => void>()

  return {
    replayStore,
    append(event: GlobalEventEnvelope) {
      if (event.payload.type === GlobalDisposedEvent.type) {
        replayStore.reset()
      }
      if (event.payload.type === "server.instance.disposed" && event.directory) {
        replayStore.clearDirectory(event.directory)
      }
      const record = replayStore.append(event)
      const packet = record ? packetForRecord(record) : packetForEnvelope(event)
      for (const listener of listeners) listener(packet)
      return packet
    },
    subscribe(listener: (packet: GlobalEventReplayPacket) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function openGlobalEventReplayConnection(input: {
  bridge: ReturnType<typeof createGlobalEventReplayBridge>
  lastEventID?: string
  push: (packet: GlobalEventReplayPacket) => void
}) {
  const liveBuffer: GlobalEventReplayPacket[] = []
  let replaying = true
  const pushLive = (packet: GlobalEventReplayPacket) => {
    if (replaying) {
      liveBuffer.push(packet)
      return
    }
    input.push(packet)
  }

  const unsubscribeLive = input.bridge.subscribe(pushLive)
  const opened = input.bridge.replayStore.snapshot(input.lastEventID)

  const pushConnected = (id?: string) => {
    input.push({
      id,
      data: JSON.stringify({
        payload: {
          type: "server.connected",
          properties: {},
        },
      }),
    })
  }

  // Fresh connect seeds a cursor. Valid reconnect replays only missed records.
  // Invalid or gapped reconnect sends one refresh signal and advances the cursor.
  if (!input.lastEventID) {
    pushConnected(opened.fenceID)
  }

  for (const record of opened.replay) {
    input.push(packetForRecord(record))
  }

  if (input.lastEventID && (opened.invalidCursor || opened.gap)) {
    pushConnected(opened.fenceID)
  }

  replaying = false
  for (const packet of liveBuffer) {
    if (packet.replaySeq !== undefined && packet.replaySeq <= opened.fenceSeq) continue
    input.push(packet)
  }
  liveBuffer.length = 0

  return () => {
    unsubscribeLive()
  }
}

const globalEventReplay = createGlobalEventReplayBridge()

GlobalBus.on("event", (event) => {
  globalEventReplay.append(event as GlobalEventEnvelope)
})

async function streamEvents(c: Context, subscribe: (q: AsyncQueue<string | null>) => () => void) {
  return streamSSE(c, async (stream) => {
    const q = new AsyncQueue<string | null>()
    let done = false

    q.push(
      JSON.stringify({
        payload: {
          type: "server.connected",
          properties: {},
        },
      }),
    )

    // Send heartbeat every 10s to prevent stalled proxy streams.
    const heartbeat = setInterval(() => {
      q.push(
        JSON.stringify({
          payload: {
            type: "server.heartbeat",
            properties: {},
          },
        }),
      )
    }, 10_000)

    const stop = () => {
      if (done) return
      done = true
      clearInterval(heartbeat)
      unsub()
      q.push(null)
      log.info("global event disconnected")
    }

    const unsub = subscribe(q)

    stream.onAbort(stop)

    try {
      for await (const data of q) {
        if (data === null) return
        await stream.writeSSE({ data })
      }
    } finally {
      stop()
    }
  })
}

export async function streamGlobalEvents(
  c: Context,
  bridge: ReturnType<typeof createGlobalEventReplayBridge> = globalEventReplay,
) {
  const lastEventID = c.req.header("Last-Event-ID") ?? c.req.header("last-event-id") ?? undefined

  return streamSSE(c, async (stream) => {
    const q = new AsyncQueue<SsePacket | null>()
    let done = false
    const unsubscribe = openGlobalEventReplayConnection({
      bridge,
      lastEventID,
      push: (packet) => q.push(packet),
    })

    const heartbeat = setInterval(() => {
      q.push({
        data: JSON.stringify({
          payload: {
            type: "server.heartbeat",
            properties: {},
          },
        }),
      })
    }, 10_000)

    const stop = () => {
      if (done) return
      done = true
      clearInterval(heartbeat)
      unsubscribe()
      q.push(null)
      log.info("global event disconnected")
    }

    stream.onAbort(stop)

    try {
      for await (const packet of q) {
        if (packet === null) return
        const { replaySeq: _replaySeq, ...sse } = packet
        await stream.writeSSE(sse)
      }
    } finally {
      stop()
    }
  })
}

export const GlobalRoutes = lazy(() =>
  new Hono()
    .get(
      "/health",
      describeRoute({
        summary: "Get health",
        description: "Get health information about the OpenCode server.",
        operationId: "global.health",
        responses: {
          200: {
            description: "Health information",
            content: {
              "application/json": {
                schema: resolver(z.object({ healthy: z.literal(true), version: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ healthy: true, version: Installation.VERSION })
      },
    )
    .get(
      "/event",
      describeRoute({
        summary: "Get global events",
        description: "Subscribe to global events from the OpenCode system using server-sent events.",
        operationId: "global.event",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      directory: z.string(),
                      project: z.string().optional(),
                      workspace: z.string().optional(),
                      payload: BusEvent.payloads(),
                    })
                    .meta({
                      ref: "GlobalEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("global event connected")
        c.header("Cache-Control", "no-cache, no-transform")
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")

        return streamGlobalEvents(c)
      },
    )
    .get(
      "/sync-event",
      describeRoute({
        summary: "Subscribe to global sync events",
        description: "Get global sync events",
        operationId: "global.sync-event.subscribe",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      payload: SyncEvent.payloads(),
                    })
                    .meta({
                      ref: "SyncEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("global sync event connected")
        c.header("Cache-Control", "no-cache, no-transform")
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")
        return streamEvents(c, (q) => {
          return SyncEvent.subscribeAll(({ def, event }) => {
            // TODO: don't pass def, just pass the type (and it should
            // be versioned)
            q.push(
              JSON.stringify({
                payload: {
                  ...event,
                  type: SyncEvent.versionedType(def.type, def.version),
                },
              }),
            )
          })
        })
      },
    )
    .get(
      "/config",
      describeRoute({
        summary: "Get global configuration",
        description: "Retrieve the current global OpenCode configuration settings and preferences.",
        operationId: "global.config.get",
        responses: {
          200: {
            description: "Get global config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Config.getGlobal())
      },
    )
    .patch(
      "/config",
      describeRoute({
        summary: "Update global configuration",
        description: "Update global OpenCode configuration settings and preferences.",
        operationId: "global.config.update",
        responses: {
          200: {
            description: "Successfully updated global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info.zod),
      async (c) => {
        const config = c.req.valid("json")
        const next = await Config.updateGlobal(config)
        return c.json(next)
      },
    )
    .post(
      "/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        operationId: "global.dispose",
        responses: {
          200: {
            description: "Global disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Instance.disposeAll()
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: GlobalDisposedEvent.type,
            properties: {},
          },
        })
        return c.json(true)
      },
    )
    .post(
      "/upgrade",
      describeRoute({
        summary: "Upgrade opencode",
        description: "Upgrade opencode to the specified version or latest if not specified.",
        operationId: "global.upgrade",
        responses: {
          200: {
            description: "Upgrade result",
            content: {
              "application/json": {
                schema: resolver(
                  z.union([
                    z.object({
                      success: z.literal(true),
                      version: z.string(),
                    }),
                    z.object({
                      success: z.literal(false),
                      error: z.string(),
                    }),
                  ]),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          target: z.string().optional(),
        }),
      ),
      async (c) => {
        const result = await AppRuntime.runPromise(
          Installation.Service.use((svc) =>
            Effect.gen(function* () {
              const method = yield* svc.method()
              if (method === "unknown") {
                return { success: false as const, status: 400 as const, error: "Unknown installation method" }
              }

              const target = c.req.valid("json").target || (yield* svc.latest(method))
              const result = yield* Effect.catch(
                svc.upgrade(method, target).pipe(Effect.as({ success: true as const, version: target })),
                (err) =>
                  Effect.succeed({
                    success: false as const,
                    status: 500 as const,
                    error: err instanceof Error ? err.message : String(err),
                  }),
              )
              if (!result.success) return result
              return { ...result, status: 200 as const }
            }),
          ),
        )
        if (!result.success) {
          return c.json({ success: false, error: result.error }, result.status)
        }
        const target = result.version
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: Installation.Event.Updated.type,
            properties: { version: target },
          },
        })
        return c.json({ success: true, version: target })
      },
    ),
)
