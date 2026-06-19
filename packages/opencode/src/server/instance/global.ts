import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
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
import { requestContextFromHono, withRequestContext } from "@/server/request-context"
import { createSseResponse } from "../sse"

const log = Log.create({ service: "server" })

export const GlobalDisposedEvent = BusEvent.define("global.disposed", z.object({}))

const LifecycleCloseResult = z.object({
  status: z.enum(["completed", "deferred"]),
  lifecycleActionID: z.string(),
  affectedDirectoryKeys: z.array(z.string()),
})

export function globalEventOpenApiSchema() {
  return z
    .object({
      directory: z.string(),
      project: z.string().optional(),
      workspace: z.string().optional(),
      payload: BusEvent.payloads(),
    })
    .meta({
      ref: "GlobalEvent",
    })
}

export function globalSyncEventOpenApiSchema() {
  return z
    .object({
      payload: SyncEvent.payloads(),
    })
    .meta({
      ref: "SyncEvent",
    })
}

function emitGlobalDisposed() {
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: GlobalDisposedEvent.type,
      properties: {},
    },
  })
}

type SsePacket = {
  id?: string
  data: string
  replaySeq?: number
}

const DEFAULT_HEARTBEAT_MS = 10_000

export type GlobalEventReplayPacket = SsePacket
export type GlobalRoutesOptions = {
  replayBridge?: ReturnType<typeof createGlobalEventReplayBridge>
  syncSubscribe?: (q: AsyncQueue<string | null>) => () => void
  heartbeatMs?: number
}

function normalizeHeartbeatMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_HEARTBEAT_MS
}

function packetForEnvelope(envelope: GlobalEventEnvelope): SsePacket {
  return {
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
        // Global dispose starts a new replay generation. Online clients still
        // receive the live packet; offline clients refresh on bootID mismatch.
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

  // Do not send partial replay for invalid/gapped cursors. Missing earlier
  // events can make retained blocker records stale, so bootstrap owns recovery.
  if (opened.invalidCursor || opened.gap) {
    if (input.lastEventID) pushConnected(opened.fenceID)
  } else {
    for (const record of opened.replay) {
      input.push(packetForRecord(record))
    }
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

const runGlobalRoute: typeof AppRuntime.runPromise = (effect, options) => AppRuntime.runPromise(effect, options)

const getGlobalConfig = Effect.fn("GlobalRoutes.config.get")(function* () {
  const service = yield* Config.Service
  return yield* service.getGlobal()
})

const updateGlobalConfig = Effect.fn("GlobalRoutes.config.update")(function* (config: Config.Info) {
  const service = yield* Config.Service
  return yield* service.updateGlobal(config)
})

const disposeGlobalInstances = Effect.fn("GlobalRoutes.dispose")(function* () {
  return yield* Effect.promise(() => Instance.disposeAll({ onCompleted: emitGlobalDisposed }))
})

type UpgradeResult =
  | {
      success: true
      status: 200
      version: string
    }
  | {
      success: false
      status: 400 | 500
      error: string
    }

const upgradeInstallation = Effect.fn("GlobalRoutes.upgrade")(function* (target?: string) {
  const installation = yield* Installation.Service
  const method = yield* installation.method()
  if (method === "unknown") {
    return { success: false, status: 400, error: "Unknown installation method" } satisfies UpgradeResult
  }

  const resolvedTarget = target || (yield* installation.latest(method))
  const result = yield* Effect.catch(
    installation.upgrade(method, resolvedTarget).pipe(Effect.as({ success: true as const, version: resolvedTarget })),
    (err) =>
      Effect.succeed({
        success: false as const,
        status: 500 as const,
        error: err instanceof Error ? err.message : String(err),
      }),
  )
  if (!result.success) return result
  return { ...result, status: 200 } satisfies UpgradeResult
})

function streamEvents(
  request: Request,
  subscribe: (q: AsyncQueue<string | null>) => () => void,
  heartbeatMs = 10_000,
) {
  return createSseResponse({
    signal: request.signal,
    start(stream) {
      const q = new AsyncQueue<string | null>()
      let done = false
      let cancelled = false

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
      }, heartbeatMs)

      const stop = () => {
        if (done) return
        done = true
        clearInterval(heartbeat)
        unsub()
        q.push(null)
        log.info("global event disconnected")
      }

      const unsub = subscribe(q)

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

export function handleGlobalEventStream(
  request: Request,
  bridge: ReturnType<typeof createGlobalEventReplayBridge> = globalEventReplay,
  heartbeatMs = 10_000,
) {
  const lastEventID = request.headers.get("Last-Event-ID") ?? request.headers.get("last-event-id") ?? undefined
  log.info("global event connected")

  return createSseResponse({
    signal: request.signal,
    start(stream) {
      const q = new AsyncQueue<SsePacket | null>()
      let done = false
      let cancelled = false
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
      }, heartbeatMs)

      const stop = () => {
        if (done) return
        done = true
        clearInterval(heartbeat)
        unsubscribe()
        q.push(null)
        log.info("global event disconnected")
      }

      void (async () => {
        try {
          for await (const packet of q) {
            if (packet === null) return
            const { replaySeq: _replaySeq, ...sse } = packet
            stream.write(sse)
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

export function handleGlobalSyncEventStream(
  request: Request,
  subscribe: (q: AsyncQueue<string | null>) => () => void,
  heartbeatMs = 10_000,
) {
  log.info("global sync event connected")
  return streamEvents(request, subscribe, heartbeatMs)
}

export function createGlobalRoutes(options: GlobalRoutesOptions = {}) {
  const replayBridge = options.replayBridge ?? globalEventReplay
  const heartbeatMs = normalizeHeartbeatMs(options.heartbeatMs)
  const syncSubscribe =
    options.syncSubscribe ??
    ((q: AsyncQueue<string | null>) => {
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

  return new Hono()
    .use((c, next) => withRequestContext(requestContextFromHono(c, {}), () => next()))
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
                schema: resolver(globalEventOpenApiSchema()),
              },
            },
          },
        },
      }),
      async (c) => {
        return handleGlobalEventStream(c.req.raw, replayBridge, heartbeatMs)
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
                schema: resolver(globalSyncEventOpenApiSchema()),
              },
            },
          },
        },
      }),
      async (c) => {
        return handleGlobalSyncEventStream(c.req.raw, syncSubscribe, heartbeatMs)
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
        const config = await runGlobalRoute(getGlobalConfig())
        return c.json(config)
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
        const next = await runGlobalRoute(updateGlobalConfig(config))
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
                schema: resolver(LifecycleCloseResult),
              },
            },
          },
        },
      }),
      async (c) => {
        const result = await runGlobalRoute(disposeGlobalInstances())
        return c.json(result)
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
        const json = c.req.valid("json")
        const result = await runGlobalRoute(upgradeInstallation(json.target))
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
    )
}

export const GlobalRoutes = lazy(() => createGlobalRoutes())
