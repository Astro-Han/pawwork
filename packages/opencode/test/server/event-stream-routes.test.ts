import { afterEach, describe, expect, test } from "bun:test"
import z from "zod"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { Instance } from "../../src/project/instance"
import { EventReplayStore } from "../../src/server/event-replay"
import { handleInstanceEventStream } from "../../src/server/instance/event"
import {
  createGlobalEventReplayBridge,
  handleGlobalEventStream,
  handleGlobalSyncEventStream,
} from "../../src/server/instance/global"
import type { AsyncQueue } from "../../src/util/queue"
import { tmpdir } from "../fixture/fixture"

type SseFrame = {
  event?: string
  id?: string
  retry?: string
  data?: unknown
  raw: string
}

const TestEvent = BusEvent.define("test.sse.route", z.object({ value: z.number() }))

const envelope = (type: string, id = type) => ({
  directory: "/repo",
  payload: {
    type,
    properties: type === "permission.asked" ? { id, sessionID: "ses_1", questions: [] } : { id },
  },
})

afterEach(() => Instance.disposeAll())

function expectSseHeaders(response: Response) {
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(response.headers.get("cache-control")).toBe("no-cache")
  expect(response.headers.get("x-accel-buffering")).toBe("no")
  expect(response.headers.get("x-content-type-options")).toBe("nosniff")
}

function parseFrame(raw: string): SseFrame {
  const data: string[] = []
  let event: string | undefined
  let id: string | undefined
  let retry: string | undefined
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.replace(/^event:\s*/, "")
    if (line.startsWith("id:")) id = line.replace(/^id:\s*/, "")
    if (line.startsWith("retry:")) retry = line.replace(/^retry:\s*/, "")
    if (line.startsWith("data:")) data.push(line.replace(/^data:\s*/, ""))
  }
  const body = data.join("\n")
  return {
    event,
    id,
    retry,
    data: body ? JSON.parse(body) : undefined,
    raw,
  }
}

function expectNoSseControlFields(frames: SseFrame[]) {
  for (const frame of frames) {
    expect(frame.event).toBeUndefined()
    expect(frame.retry).toBeUndefined()
  }
}

function createSseReader(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Expected SSE response body")
  const decoder = new TextDecoder()
  let text = ""

  return {
    async read(count: number, timeoutMs = 2_000) {
      const frames: SseFrame[] = []
      const deadline = Date.now() + timeoutMs

      while (frames.length < count) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error(`Timed out waiting for ${count} SSE frames. Received: ${text}`)
        let timeout: ReturnType<typeof setTimeout> | undefined
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`Timed out reading SSE stream. Received: ${text}`)), remaining)
          }),
        ]).finally(() => {
          if (timeout) clearTimeout(timeout)
        })
        if (next.done) break
        text += decoder.decode(next.value, { stream: true })
        text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
        const chunks = text.split("\n\n")
        text = chunks.pop() ?? ""
        for (const chunk of chunks) {
          if (chunk.trim()) frames.push(parseFrame(chunk))
        }
      }
      if (frames.length < count) throw new Error(`SSE stream ended before ${count} frames. Received: ${text}`)
      return frames
    },
    cancel() {
      return reader.cancel()
    },
  }
}

async function readSseFrames(response: Response, count: number, timeoutMs = 2_000) {
  const reader = createSseReader(response)
  try {
    return await reader.read(count, timeoutMs)
  } finally {
    await reader.cancel()
  }
}

function globalEventResponse(
  bridge: ReturnType<typeof createGlobalEventReplayBridge>,
  init?: RequestInit,
) {
  return handleGlobalEventStream(new Request("http://localhost/global/event", init), bridge, 5)
}

describe("SSE event routes", () => {
  test("global event fresh connect seeds a replay cursor through the real route", async () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    bridge.append(envelope("permission.asked", "q1"))

    const response = globalEventResponse(bridge)

    expectSseHeaders(response)
    const [connected] = await readSseFrames(response, 1)
    expectNoSseControlFields([connected])
    expect(connected.id).toBe("boot:1")
    expect(connected.data).toEqual({ payload: { type: "server.connected", properties: {} } })
  })

  test("global event valid reconnect replays missed records without connected", async () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    bridge.append(envelope("permission.asked", "q1"))
    bridge.append(envelope("permission.replied", "q1"))

    const response = globalEventResponse(bridge, {
      headers: { "Last-Event-ID": "boot:1" },
    })

    const frames = await readSseFrames(response, 2, 2_000)
    expectNoSseControlFields(frames)
    const [replayed, heartbeat] = frames
    expect(replayed.id).toBe("boot:2")
    expect(replayed.data).toEqual(envelope("permission.replied", "q1"))
    expect(replayed.raw).not.toContain("server.connected")
    expect(replayed.raw).not.toContain("replaySeq")
    expect(heartbeat.id).toBeUndefined()
    expect(heartbeat.data).toEqual({ payload: { type: "server.heartbeat", properties: {} } })
  })

  test("global event accepts lowercase last-event-id", async () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    bridge.append(envelope("permission.asked", "q1"))
    bridge.append(envelope("permission.replied", "q1"))

    const response = globalEventResponse(bridge, {
      headers: { "last-event-id": "boot:1" },
    })

    const [replayed] = await readSseFrames(response, 1)
    expectNoSseControlFields([replayed])
    expect(replayed.id).toBe("boot:2")
    expect(replayed.data).toEqual(envelope("permission.replied", "q1"))
  })

  test("global event stale cursor sends only a connected fence", async () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    bridge.append(envelope("permission.asked", "q1"))

    const response = globalEventResponse(bridge, {
      headers: { "Last-Event-ID": "old:1" },
    })

    const frames = await readSseFrames(response, 2)
    expectNoSseControlFields(frames)
    const [connected, heartbeat] = frames
    expect(connected.id).toBe("boot:1")
    expect(connected.data).toEqual({ payload: { type: "server.connected", properties: {} } })
    expect(connected.raw).not.toContain("permission.asked")
    expect(heartbeat.id).toBeUndefined()
    expect(heartbeat.data).toEqual({ payload: { type: "server.heartbeat", properties: {} } })
  })

  test("global event gapped cursor skips partial replay", async () => {
    const bridge = createGlobalEventReplayBridge({
      replayStore: new EventReplayStore({ bootID: "boot", maxRecords: 1 }),
    })
    bridge.append(envelope("permission.asked", "q1"))
    bridge.append(envelope("permission.replied", "q1"))

    const response = globalEventResponse(bridge, {
      headers: { "Last-Event-ID": "boot:0" },
    })

    const frames = await readSseFrames(response, 2)
    expectNoSseControlFields(frames)
    const [connected, heartbeat] = frames
    expect(connected.id).toBe("boot:2")
    expect(connected.data).toEqual({ payload: { type: "server.connected", properties: {} } })
    expect(connected.raw).not.toContain("permission.asked")
    expect(connected.raw).not.toContain("permission.replied")
    expect(heartbeat.id).toBeUndefined()
    expect(heartbeat.data).toEqual({ payload: { type: "server.heartbeat", properties: {} } })
  })

  test("global event live replayable packets carry ids and heartbeat packets do not", async () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    const response = globalEventResponse(bridge)

    const reader = createSseReader(response)
    try {
      const [connected] = await reader.read(1)
      expectNoSseControlFields([connected])
      expect(connected.id).toBe("boot:0")

      bridge.append(envelope("permission.asked", "q1"))
      bridge.append(envelope("message.part.delta", "delta1"))
      const frames = await reader.read(3)
      expectNoSseControlFields(frames)

      expect(frames.map((frame) => (frame.data as { payload: { type: string } }).payload.type)).toContain(
        "permission.asked",
      )
      expect(
        frames.find((frame) => (frame.data as { payload: { type: string } }).payload.type === "permission.asked")?.id,
      ).toBe("boot:1")
      const deltaFrame = frames.find(
        (frame) => (frame.data as { payload: { type: string } }).payload.type === "message.part.delta",
      )
      expect(deltaFrame).toBeDefined()
      expect(deltaFrame?.id).toBe(undefined)
      expect(
        frames.find((frame) => (frame.data as { payload: { type: string } }).payload.type === "server.heartbeat")?.id,
      ).toBe(undefined)
    } finally {
      await reader.cancel()
    }
  })

  test("instance event route uses bare bus event frames", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = handleInstanceEventStream(new Request("http://localhost/event"), { heartbeatMs: 5 })

        expectSseHeaders(response)
        const reader = createSseReader(response)
        try {
          const [connected] = await reader.read(1)
          expectNoSseControlFields([connected])
          expect(connected.id).toBeUndefined()
          expect(connected.data).toEqual({ type: "server.connected", properties: {} })

          await Bus.publish(TestEvent, { value: 7 })
          const [event, heartbeat] = await reader.read(2)
          expectNoSseControlFields([event, heartbeat])
          expect(event.id).toBeUndefined()
          expect(event.data).toEqual({ type: "test.sse.route", properties: { value: 7 } })
          expect(heartbeat.id).toBeUndefined()
          expect(heartbeat.data).toEqual({ type: "server.heartbeat", properties: {} })
        } finally {
          await reader.cancel()
        }
      },
    })
  })

  test("global sync event route uses enveloped frames", async () => {
    const response = handleGlobalSyncEventStream(
      new Request("http://localhost/global/sync-event"),
      (q: AsyncQueue<string | null>) => {
        q.push(JSON.stringify({ payload: { type: "sync.fixture.1", id: "evt_1" } }))
        return () => {}
      },
      5,
    )

    expectSseHeaders(response)
    const [connected, fixture, heartbeat] = await readSseFrames(response, 3)
    expectNoSseControlFields([connected, fixture, heartbeat])
    expect(connected.id).toBeUndefined()
    expect(connected.data).toEqual({ payload: { type: "server.connected", properties: {} } })
    expect(fixture.id).toBeUndefined()
    expect(fixture.data).toEqual({ payload: { type: "sync.fixture.1", id: "evt_1" } })
    expect(heartbeat.id).toBeUndefined()
    expect(heartbeat.data).toEqual({ payload: { type: "server.heartbeat", properties: {} } })
  })
})
