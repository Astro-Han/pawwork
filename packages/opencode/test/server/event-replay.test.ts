import { describe, expect, test } from "bun:test"
import { EventReplayStore, isReplayableGlobalEvent, parseReplayCursor } from "../../src/server/event-replay"

const question = (id: string, sessionID = "ses_1") => ({
  directory: "/repo",
  project: "proj",
  workspace: "work",
  payload: {
    type: "question.asked",
    properties: { id, sessionID, questions: [{ header: "H", question: "Q", options: [] }] },
  },
})

const event = (type: string) => ({
  directory: "/repo",
  payload: {
    type,
    properties: {},
  },
})

describe("parseReplayCursor", () => {
  test("parses boot id and numeric sequence", () => {
    expect(parseReplayCursor("boot-abc:42")).toEqual({ bootID: "boot-abc", seq: 42 })
  })

  test("rejects malformed cursors", () => {
    expect(parseReplayCursor(undefined)).toBeUndefined()
    expect(parseReplayCursor("")).toBeUndefined()
    expect(parseReplayCursor("boot")).toBeUndefined()
    expect(parseReplayCursor("boot:abc")).toBeUndefined()
    expect(parseReplayCursor("boot:-1")).toBeUndefined()
  })
})

describe("isReplayableGlobalEvent", () => {
  test("allows blocker and session state events", () => {
    expect(isReplayableGlobalEvent(event("question.asked"))).toBe(true)
    expect(isReplayableGlobalEvent(event("question.replied"))).toBe(true)
    expect(isReplayableGlobalEvent(event("question.rejected"))).toBe(true)
    expect(isReplayableGlobalEvent(event("permission.asked"))).toBe(true)
    expect(isReplayableGlobalEvent(event("permission.replied"))).toBe(true)
    expect(isReplayableGlobalEvent(event("session.created"))).toBe(true)
    expect(isReplayableGlobalEvent(event("session.updated"))).toBe(true)
    expect(isReplayableGlobalEvent(event("session.deleted"))).toBe(true)
    expect(isReplayableGlobalEvent(event("session.status"))).toBe(true)
  })

  test("rejects high-volume and unrelated events", () => {
    expect(isReplayableGlobalEvent(event("message.part.delta"))).toBe(false)
    expect(isReplayableGlobalEvent(event("message.part.updated"))).toBe(false)
    expect(isReplayableGlobalEvent(event("message.updated"))).toBe(false)
    expect(isReplayableGlobalEvent(event("todo.updated"))).toBe(false)
    expect(isReplayableGlobalEvent(event("lsp.updated"))).toBe(false)
    expect(isReplayableGlobalEvent(event("vcs.branch.updated"))).toBe(false)
  })
})

describe("EventReplayStore", () => {
  test("assigns monotonic ids under one boot id", () => {
    const store = new EventReplayStore({ bootID: "boot", now: () => 1000 })
    const first = store.append(question("q1"))
    const second = store.append(question("q2"))

    expect(first?.id).toBe("boot:1")
    expect(second?.id).toBe("boot:2")
    expect(store.latestID()).toBe("boot:2")
  })

  test("does not store non-replayable events", () => {
    const store = new EventReplayStore({ bootID: "boot", now: () => 1000 })
    expect(store.append(event("message.part.delta"))).toBeUndefined()
    expect(store.recordsForTest()).toEqual([])
    expect(store.latestID()).toBe("boot:0")
  })

  test("stores cloned envelopes", () => {
    const store = new EventReplayStore({ bootID: "boot", now: () => 1000 })
    const input = question("q1")
    const record = store.append(input)
    ;(input.payload.properties as { id: string }).id = "mutated"

    expect((record?.envelope.payload.properties as { id: string }).id).toBe("q1")
    expect((store.recordsForTest()[0].envelope.payload.properties as { id: string }).id).toBe("q1")
  })

  test("prunes by max record count", () => {
    const store = new EventReplayStore({ bootID: "boot", maxRecords: 2, now: () => 1000 })
    store.append(question("q1"))
    store.append(question("q2"))
    store.append(question("q3"))

    expect(store.recordsForTest().map((record) => record.seq)).toEqual([2, 3])
  })

  test("prunes by max age", () => {
    let now = 1000
    const store = new EventReplayStore({ bootID: "boot", maxAgeMs: 100, now: () => now })
    store.append(question("q1"))
    now = 1200
    store.append(question("q2"))

    expect(store.recordsForTest().map((record) => record.seq)).toEqual([2])
  })

  test("replays records after cursor in ascending order", () => {
    const store = new EventReplayStore({ bootID: "boot", now: () => 1000 })
    store.append(question("q1"))
    store.append(question("q2"))
    store.append(question("q3"))

    const opened = store.open("boot:1", () => {})

    expect(opened.invalidCursor).toBe(false)
    expect(opened.gap).toBe(false)
    expect(opened.replay.map((record) => record.id)).toEqual(["boot:2", "boot:3"])
    opened.unsubscribe()
  })

  test("returns no replay for invalid boot id", () => {
    const store = new EventReplayStore({ bootID: "boot", now: () => 1000 })
    store.append(question("q1"))

    const opened = store.open("old:1", () => {})

    expect(opened.invalidCursor).toBe(true)
    expect(opened.gap).toBe(false)
    expect(opened.replay).toEqual([])
    expect(opened.fenceID).toBe("boot:1")
    opened.unsubscribe()
  })

  test("treats a same-boot future cursor as invalid", () => {
    const store = new EventReplayStore({ bootID: "boot", now: () => 1000 })
    store.append(question("q1"))

    const opened = store.open("boot:99", () => {})

    expect(opened.invalidCursor).toBe(true)
    expect(opened.replay).toEqual([])
    expect(opened.fenceID).toBe("boot:1")
    opened.unsubscribe()
  })

  test("detects a gap when cursor is older than retained records", () => {
    const store = new EventReplayStore({ bootID: "boot", maxRecords: 2, now: () => 1000 })
    store.append(question("q1"))
    store.append(question("q2"))
    store.append(question("q3"))

    const opened = store.open("boot:0", () => {})

    expect(opened.gap).toBe(true)
    expect(opened.replay.map((record) => record.id)).toEqual(["boot:2", "boot:3"])
    opened.unsubscribe()
  })

  test("buffers live records during replay and releases only records after the fence", () => {
    const store = new EventReplayStore({ bootID: "boot", now: () => 1000 })
    store.append(question("q1"))

    const live: string[] = []
    const opened = store.open("boot:0", (record) => live.push(record.id))
    store.append(question("q2"))

    expect(opened.fenceID).toBe("boot:1")
    expect(opened.replay.map((record) => record.id)).toEqual(["boot:1"])
    expect(live).toEqual([])

    opened.releaseLiveQueue((record) => live.push(record.id))

    expect(live).toEqual(["boot:2"])
    opened.unsubscribe()
  })
})
