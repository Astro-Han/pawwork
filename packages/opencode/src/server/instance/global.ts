import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { AsyncQueue } from "@/util/queue"
import { Log } from "@opencode-ai/core/util/log"
import { EventReplayStore, type GlobalEventEnvelope, type ReplayRecord } from "../event-replay"
import { createSseResponse } from "../sse"

const log = Log.create({ service: "server" })

export const GlobalDisposedEvent = BusEvent.define("global.disposed", z.object({}))

export function emitGlobalDisposed() {
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
export type GlobalEventStreamOptions = {
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
