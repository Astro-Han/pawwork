import { describe, expect, test } from "bun:test"
import { EventReplayStore } from "../../src/server/event-replay"
import {
  createGlobalEventReplayBridge,
  handleGlobalEventStream,
  openGlobalEventReplayConnection,
} from "../../src/server/instance/global"

const envelope = (type: string, id = type) => ({
  directory: "/repo",
  payload: {
    type,
    properties: type === "permission.asked" ? { id, sessionID: "ses_1", questions: [] } : { id },
  },
})

async function readSseUntil(response: Response, predicate: (text: string) => boolean, timeoutMs = 2_000) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Expected SSE response body")
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + timeoutMs
  try {
    while (!predicate(text)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`Timed out waiting for SSE payload. Received: ${text}`)
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timed out reading SSE stream. Received: ${text}`)), remaining),
        ),
      ])
      if (next.done) break
      text += decoder.decode(next.value, { stream: true })
    }
    if (!predicate(text)) throw new Error(`SSE stream ended before expected payload. Received: ${text}`)
    return text
  } finally {
    await reader.cancel()
  }
}

describe("createGlobalEventReplayBridge", () => {
  test("live broadcasts replayable events with ids and non-replayable events without ids", () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    const packets: Array<{ id?: string; replaySeq?: number; data: string }> = []
    const unsubscribe = bridge.subscribe((packet) => packets.push(packet))

    bridge.append(envelope("permission.asked", "q1"))
    bridge.append(envelope("message.part.delta", "delta1"))

    expect(packets[0].id).toBe("boot:1")
    expect(packets[0].replaySeq).toBe(1)
    expect(JSON.parse(packets[0].data).payload.type).toBe("permission.asked")
    expect(packets[1].id).toBeUndefined()
    expect(packets[1].replaySeq).toBeUndefined()
    expect(JSON.parse(packets[1].data).payload.type).toBe("message.part.delta")
    unsubscribe()
  })

  test("connection seeds a fresh cursor and valid reconnect replays without server.connected", () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    bridge.append(envelope("permission.asked", "q1"))
    const fresh: Array<{ id?: string; replaySeq?: number; data: string }> = []

    openGlobalEventReplayConnection({ bridge, push: (packet) => fresh.push(packet) })()

    expect(fresh[0].id).toBe("boot:1")

    bridge.append(envelope("permission.replied", "q1"))
    const reconnect: Array<{ id?: string; replaySeq?: number; data: string }> = []

    openGlobalEventReplayConnection({
      bridge,
      lastEventID: "boot:1",
      push: (packet) => reconnect.push(packet),
    })()

    expect(reconnect.map((packet) => JSON.parse(packet.data).payload.type)).toEqual(["permission.replied"])
    expect(reconnect[0].id).toBe("boot:2")
  })

  test("invalid reconnect emits one server.connected with the fence id", () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    bridge.append(envelope("permission.asked", "q1"))
    const packets: Array<{ id?: string; replaySeq?: number; data: string }> = []

    openGlobalEventReplayConnection({
      bridge,
      lastEventID: "old:1",
      push: (packet) => packets.push(packet),
    })()

    expect(packets.map((packet) => JSON.parse(packet.data).payload.type)).toEqual(["server.connected"])
    expect(packets[0].id).toBe("boot:1")
  })

  test("gapped reconnect sends only server.connected and skips partial replay", () => {
    const bridge = createGlobalEventReplayBridge({
      replayStore: new EventReplayStore({ bootID: "boot", maxRecords: 1 }),
    })
    bridge.append(envelope("permission.asked", "q1"))
    bridge.append(envelope("permission.replied", "q1"))
    const packets: Array<{ id?: string; replaySeq?: number; data: string }> = []

    openGlobalEventReplayConnection({
      bridge,
      lastEventID: "boot:0",
      push: (packet) => packets.push(packet),
    })()

    expect(packets.map((packet) => JSON.parse(packet.data).payload.type)).toEqual(["server.connected"])
    expect(packets[0].id).toBe("boot:2")
  })

  test("dispose events invalidate retained replay records", () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    bridge.append(envelope("permission.asked", "q1"))
    bridge.append({
      directory: "/repo",
      payload: {
        type: "server.instance.disposed",
        properties: { directory: "/repo" },
      },
    })
    const packets: Array<{ id?: string; replaySeq?: number; data: string }> = []

    openGlobalEventReplayConnection({
      bridge,
      lastEventID: "boot:0",
      push: (packet) => packets.push(packet),
    })()

    expect(packets.map((packet) => JSON.parse(packet.data).payload.type)).toEqual(["server.connected"])
    expect(packets[0].id).toBe("boot:2")
  })

  test("global dispose resets the replay generation and clears retained records", () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    bridge.append(envelope("permission.asked", "q1"))

    const packet = bridge.append({
      payload: {
        type: "global.disposed",
        properties: {},
      },
    })

    expect(JSON.parse(packet.data).payload.type).toBe("global.disposed")
    expect(packet.id).toBeUndefined()
    expect(bridge.replayStore.recordsForTest()).toEqual([])
    expect(bridge.replayStore.latestID()).not.toBe("boot:1")
  })

  test("missed instance dispose advances reconnect recovery from the previous fence", () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    bridge.append(envelope("permission.asked", "q1"))
    bridge.append({
      directory: "/repo",
      payload: {
        type: "server.instance.disposed",
        properties: { directory: "/repo" },
      },
    })
    const packets: Array<{ id?: string; replaySeq?: number; data: string }> = []

    openGlobalEventReplayConnection({
      bridge,
      lastEventID: "boot:1",
      push: (packet) => packets.push(packet),
    })()

    expect(packets.map((packet) => JSON.parse(packet.data).payload.type)).toEqual(["server.instance.disposed"])
    expect(packets[0].id).toBe("boot:2")
  })

  test("route reads Last-Event-ID and writes replay ids into SSE output", async () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    bridge.append(envelope("permission.asked", "q1"))
    const controller = new AbortController()

    const response = handleGlobalEventStream(
      new Request("http://localhost/global/event", {
        headers: { "Last-Event-ID": "boot:0" },
        signal: controller.signal,
      }),
      bridge,
    )
    expect(response.status).toBe(200)
    const text = await readSseUntil(response, (value) => value.includes("permission.asked"))
    controller.abort()

    expect(text).toContain("id: boot:1")
    expect(text).toContain("data: {\"directory\":\"/repo\",\"payload\":{\"type\":\"permission.asked\"")
    expect(text).not.toContain("server.connected")
  })
})
