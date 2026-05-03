import { describe, expect, test } from "bun:test"
import { EventReplayStore } from "../../src/server/event-replay"
import { createGlobalEventReplayBridge, openGlobalEventReplayConnection } from "../../src/server/instance/global"

const envelope = (type: string, id = type) => ({
  directory: "/repo",
  payload: {
    type,
    properties: type === "question.asked" ? { id, sessionID: "ses_1", questions: [] } : { id },
  },
})

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

  test("connection seeds a fresh cursor and replays missed records after Last-Event-ID", () => {
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

    expect(reconnect.map((packet) => JSON.parse(packet.data).payload.type)).toEqual([
      "server.connected",
      "question.replied",
    ])
    expect(reconnect[0].id).toBeUndefined()
    expect(reconnect[1].id).toBe("boot:2")
  })

  test("connection signals a gap even when partial replay records are available", () => {
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

    expect(packets.map((packet) => JSON.parse(packet.data).payload.type)).toEqual([
      "server.connected",
      "question.replied",
      "server.connected",
    ])
    expect(packets.at(-1)?.id).toBe("boot:2")
  })
})
