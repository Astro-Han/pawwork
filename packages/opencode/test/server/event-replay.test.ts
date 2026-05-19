import { describe, expect, test } from "bun:test"
import { EventReplayStore, isReplayableGlobalEvent, parseReplayCursor } from "../../src/server/event-replay"

const question = (id: string, sessionID = "ses_1") => ({
  directory: "/repo",
  project: "proj",
  workspace: "work",
  payload: {
    type: "permission.asked",
    properties: { id, sessionID },
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
  test("allows permission, session state, and todo events", () => {
    expect(isReplayableGlobalEvent(event("permission.asked"))).toBe(true)
    expect(isReplayableGlobalEvent(event("permission.replied"))).toBe(true)
    expect(isReplayableGlobalEvent(event("session.created"))).toBe(true)
    expect(isReplayableGlobalEvent(event("session.updated"))).toBe(true)
    expect(isReplayableGlobalEvent(event("session.deleted"))).toBe(true)
    expect(isReplayableGlobalEvent(event("session.status"))).toBe(true)
    expect(isReplayableGlobalEvent(event("todo.updated"))).toBe(true)
    expect(isReplayableGlobalEvent(event("server.instance.disposed"))).toBe(true)
  })

  test("rejects deleted question and blocker events", () => {
    expect(isReplayableGlobalEvent(event("question.asked"))).toBe(false)
    expect(isReplayableGlobalEvent(event("question.replied"))).toBe(false)
    expect(isReplayableGlobalEvent(event("question.rejected"))).toBe(false)
    expect(isReplayableGlobalEvent(event("session.blocker.upserted"))).toBe(false)
    expect(isReplayableGlobalEvent(event("session.blocker.removed"))).toBe(false)
  })

  test("rejects high-volume and unrelated events", () => {
    expect(isReplayableGlobalEvent(event("message.part.delta"))).toBe(false)
    expect(isReplayableGlobalEvent(event("message.part.updated"))).toBe(false)
    expect(isReplayableGlobalEvent(event("message.updated"))).toBe(false)
    expect(isReplayableGlobalEvent(event("lsp.updated"))).toBe(false)
    expect(isReplayableGlobalEvent(event("vcs.branch.updated"))).toBe(false)
  })
})

describe("EventReplayStore", () => {
  test("rejects invalid retention configuration", () => {
    expect(() => new EventReplayStore({ maxRecords: -1 })).toThrow(RangeError)
    expect(() => new EventReplayStore({ maxRecords: 1.5 })).toThrow(RangeError)
    expect(() => new EventReplayStore({ maxAgeMs: -1 })).toThrow(RangeError)
    expect(() => new EventReplayStore({ maxAgeMs: Number.NaN })).toThrow(RangeError)
  })

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

    const opened = store.snapshot("boot:1")

    expect(opened.invalidCursor).toBe(false)
    expect(opened.gap).toBe(false)
    expect(opened.replay.map((record) => record.id)).toEqual(["boot:2", "boot:3"])
  })

  test("replays permission and session state events after cursor", () => {
    const store = new EventReplayStore({ bootID: "boot", now: () => 1000 })
    store.append(event("session.created"))
    store.append(event("permission.asked"))
    store.append(event("permission.replied"))

    const opened = store.snapshot("boot:1")

    expect(opened.invalidCursor).toBe(false)
    expect(opened.gap).toBe(false)
    expect(opened.replay.map((record) => record.envelope.payload.type)).toEqual([
      "permission.asked",
      "permission.replied",
    ])
  })

  test("returns no replay for invalid boot id", () => {
    const store = new EventReplayStore({ bootID: "boot", now: () => 1000 })
    store.append(question("q1"))

    const opened = store.snapshot("old:1")

    expect(opened.invalidCursor).toBe(true)
    expect(opened.gap).toBe(false)
    expect(opened.replay).toEqual([])
    expect(opened.fenceID).toBe("boot:1")
  })

  test("treats a same-boot future cursor as invalid", () => {
    const store = new EventReplayStore({ bootID: "boot", now: () => 1000 })
    store.append(question("q1"))

    const opened = store.snapshot("boot:99")

    expect(opened.invalidCursor).toBe(true)
    expect(opened.replay).toEqual([])
    expect(opened.fenceID).toBe("boot:1")
  })

  test("detects a gap when cursor is older than retained records", () => {
    const store = new EventReplayStore({ bootID: "boot", maxRecords: 2, now: () => 1000 })
    store.append(question("q1"))
    store.append(question("q2"))
    store.append(question("q3"))

    const opened = store.snapshot("boot:0")

    expect(opened.gap).toBe(true)
    expect(opened.replay.map((record) => record.id)).toEqual(["boot:2", "boot:3"])
  })

  test("detects a gap when cursor is behind but all retained records expired", () => {
    let now = 1000
    const store = new EventReplayStore({ bootID: "boot", maxAgeMs: 100, now: () => now })
    store.append(question("q1"))
    now = 1200
    store.append(question("q2"))
    now = 1400
    store.append(question("q3"))
    now = 1600

    const opened = store.snapshot("boot:1")

    expect(store.recordsForTest()).toEqual([])
    expect(opened.gap).toBe(true)
    expect(opened.replay).toEqual([])
    expect(opened.fenceID).toBe("boot:3")
  })

  test("clears records for one disposed directory", () => {
    const store = new EventReplayStore({ bootID: "boot", now: () => 1000 })
    store.append(question("q1"))
    store.append({ ...question("q2"), directory: "/other" })

    store.clearDirectory("/repo")

    expect(store.recordsForTest().map((record) => record.envelope.directory)).toEqual(["/other"])
    expect(store.latestID()).toBe("boot:2")
  })

  test("clears all retained records without changing the cursor generation", () => {
    const store = new EventReplayStore({ bootID: "boot", now: () => 1000 })
    store.append(question("q1"))
    store.append(question("q2"))

    store.clear()

    expect(store.recordsForTest()).toEqual([])
    expect(store.latestID()).toBe("boot:2")
  })

  test("reset starts a new empty generation", () => {
    const store = new EventReplayStore({ bootID: "boot", now: () => 1000 })
    store.append(question("q1"))

    store.reset()

    expect(store.recordsForTest()).toEqual([])
    expect(store.latestID()).toMatch(/^[a-z0-9]+-[a-f0-9-]+:0$/)
  })
})
