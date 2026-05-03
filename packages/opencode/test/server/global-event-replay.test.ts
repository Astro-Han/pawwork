import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { EventReplayStore } from "../../src/server/event-replay"
import { createGlobalEventReplayBridge, openGlobalEventReplayConnection, streamGlobalEvents } from "../../src/server/instance/global"

const envelope = (type: string, id = type) => ({
  directory: "/repo",
  payload: {
    type,
    properties: type === "question.asked" ? { id, sessionID: "ses_1", questions: [] } : { id },
  },
})

async function readSseUntil(response: Response, predicate: (text: string) => boolean) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Expected SSE response body")
  const decoder = new TextDecoder()
  let text = ""
  while (!predicate(text)) {
    const next = await reader.read()
    if (next.done) break
    text += decoder.decode(next.value, { stream: true })
  }
  await reader.cancel()
  return text
}

describe("createGlobalEventReplayBridge", () => {
  test("live broadcasts replayable events with ids and non-replayable events without ids", () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    const packets: Array<{ id?: string; replaySeq?: number; data: string }> = []
    const unsubscribe = bridge.subscribe((packet) => packets.push(packet))

    bridge.append(envelope("question.asked", "q1"))
    bridge.append(envelope("message.part.delta", "delta1"))

    expect(packets[0].id).toBe("boot:1")
    expect(packets[0].replaySeq).toBe(1)
    expect(JSON.parse(packets[0].data).payload.type).toBe("question.asked")
    expect(packets[1].id).toBeUndefined()
    expect(packets[1].replaySeq).toBeUndefined()
    expect(JSON.parse(packets[1].data).payload.type).toBe("message.part.delta")
    unsubscribe()
  })

  test("connection seeds a fresh cursor and valid reconnect replays without server.connected", () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    bridge.append(envelope("question.asked", "q1"))
    const fresh: Array<{ id?: string; replaySeq?: number; data: string }> = []

    openGlobalEventReplayConnection({ bridge, push: (packet) => fresh.push(packet) })()

    expect(fresh[0].id).toBe("boot:1")

    bridge.append(envelope("question.replied", "q1"))
    const reconnect: Array<{ id?: string; replaySeq?: number; data: string }> = []

    openGlobalEventReplayConnection({
      bridge,
      lastEventID: "boot:1",
      push: (packet) => reconnect.push(packet),
    })()

    expect(reconnect.map((packet) => JSON.parse(packet.data).payload.type)).toEqual(["question.replied"])
    expect(reconnect[0].id).toBe("boot:2")
  })

  test("invalid reconnect emits one server.connected with the fence id", () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    bridge.append(envelope("question.asked", "q1"))
    const packets: Array<{ id?: string; replaySeq?: number; data: string }> = []

    openGlobalEventReplayConnection({
      bridge,
      lastEventID: "old:1",
      push: (packet) => packets.push(packet),
    })()

    expect(packets.map((packet) => JSON.parse(packet.data).payload.type)).toEqual(["server.connected"])
    expect(packets[0].id).toBe("boot:1")
  })

  test("connection signals a gap once after partial replay records are available", () => {
    const bridge = createGlobalEventReplayBridge({
      replayStore: new EventReplayStore({ bootID: "boot", maxRecords: 1 }),
    })
    bridge.append(envelope("question.asked", "q1"))
    bridge.append(envelope("question.replied", "q1"))
    const packets: Array<{ id?: string; replaySeq?: number; data: string }> = []

    openGlobalEventReplayConnection({
      bridge,
      lastEventID: "boot:0",
      push: (packet) => packets.push(packet),
    })()

    expect(packets.map((packet) => JSON.parse(packet.data).payload.type)).toEqual(["question.replied", "server.connected"])
    expect(packets[0].id).toBe("boot:2")
    expect(packets.at(-1)?.id).toBe("boot:2")
  })

  test("dispose events invalidate retained replay records", () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    bridge.append(envelope("question.asked", "q1"))
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

    expect(packets.map((packet) => JSON.parse(packet.data).payload.type)).toEqual([
      "server.instance.disposed",
      "server.connected",
    ])
    expect(packets[0].id).toBe("boot:2")
    expect(packets.at(-1)?.id).toBe("boot:2")
  })

  test("missed instance dispose advances reconnect recovery from the previous fence", () => {
    const bridge = createGlobalEventReplayBridge({ replayStore: new EventReplayStore({ bootID: "boot" }) })
    bridge.append(envelope("question.asked", "q1"))
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
    bridge.append(envelope("question.asked", "q1"))
    const app = new Hono().get("/event", (c) => streamGlobalEvents(c, bridge))
    const controller = new AbortController()

    const response = await app.request("/event", {
      headers: { "Last-Event-ID": "boot:0" },
      signal: controller.signal,
    })
    const text = await readSseUntil(response, (value) => value.includes("question.asked"))
    controller.abort()

    expect(text).toContain("id: boot:1")
    expect(text).toContain("data: {\"directory\":\"/repo\",\"payload\":{\"type\":\"question.asked\"")
    expect(text).not.toContain("server.connected")
  })
})
