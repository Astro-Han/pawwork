import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import { ExternalResult } from "../../src/tool/external-result"

const sessionA = "session-A"
const sessionB = "session-B"
const messageID = "msg-1"
const callID = "call-1"

const runEffect = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect)

const tick = (delta: number) => {
  let current = mockNow
  mockNow = current + delta
  ExternalResult.__setClockForTests(() => mockNow)
}

let mockNow = 0

beforeEach(() => {
  ExternalResult.__resetForTests()
  mockNow = 1000
  ExternalResult.__setClockForTests(() => mockNow)
})

afterEach(() => {
  ExternalResult.__resetForTests()
})

describe("tool.external-result.Registry lifecycle", () => {
  test("register makes hasPending true for that session only", async () => {
    await runEffect(
      ExternalResult.register({ sessionID: sessionA, messageID, callID, inputSnapshot: { foo: 1 } }),
    )
    expect(ExternalResult.hasPending(sessionA)).toBe(true)
    expect(ExternalResult.hasPending(sessionB)).toBe(false)
  })

  test("after resolveIfPending succeeds, hasPending is false immediately", async () => {
    await runEffect(
      ExternalResult.register({ sessionID: sessionA, messageID, callID, inputSnapshot: {} }),
    )
    const outcome = await runEffect(
      ExternalResult.resolveIfPending({ sessionID: sessionA, messageID, callID, value: { kind: "submitted" } }),
    )
    expect(outcome).toBe("resolved")
    expect(ExternalResult.hasPending(sessionA)).toBe(false)
  })

  test("second resolveIfPending within TTL returns already_resolved", async () => {
    await runEffect(
      ExternalResult.register({ sessionID: sessionA, messageID, callID, inputSnapshot: {} }),
    )
    await runEffect(
      ExternalResult.resolveIfPending({ sessionID: sessionA, messageID, callID, value: { kind: "submitted" } }),
    )
    tick(10_000)
    const second = await runEffect(
      ExternalResult.resolveIfPending({ sessionID: sessionA, messageID, callID, value: { kind: "submitted" } }),
    )
    expect(second).toBe("already_resolved")
  })

  test("second resolveIfPending after TTL elapses returns not_found", async () => {
    await runEffect(
      ExternalResult.register({ sessionID: sessionA, messageID, callID, inputSnapshot: {} }),
    )
    await runEffect(
      ExternalResult.resolveIfPending({ sessionID: sessionA, messageID, callID, value: { kind: "submitted" } }),
    )
    tick(31_000)
    const second = await runEffect(
      ExternalResult.resolveIfPending({ sessionID: sessionA, messageID, callID, value: { kind: "submitted" } }),
    )
    expect(second).toBe("not_found")
  })

  test("resolveIfPending on non-existent key returns not_found", async () => {
    const outcome = await runEffect(
      ExternalResult.resolveIfPending({ sessionID: sessionA, messageID, callID, value: {} }),
    )
    expect(outcome).toBe("not_found")
  })

  test("lookup returns pending state with inputSnapshot before resolve", async () => {
    await runEffect(
      ExternalResult.register({ sessionID: sessionA, messageID, callID, inputSnapshot: { questions: ["q1"] } }),
    )
    const result = ExternalResult.lookup({ sessionID: sessionA, messageID, callID })
    expect(result.state).toBe("pending")
    if (result.state === "pending") {
      expect(result.inputSnapshot).toEqual({ questions: ["q1"] })
    }
  })

  test("lookup returns resolved within TTL, not_found after TTL", async () => {
    await runEffect(
      ExternalResult.register({ sessionID: sessionA, messageID, callID, inputSnapshot: {} }),
    )
    await runEffect(
      ExternalResult.resolveIfPending({ sessionID: sessionA, messageID, callID, value: {} }),
    )
    expect(ExternalResult.lookup({ sessionID: sessionA, messageID, callID }).state).toBe("resolved")
    tick(31_000)
    expect(ExternalResult.lookup({ sessionID: sessionA, messageID, callID }).state).toBe("not_found")
  })

  test("Deferred returned by register receives the resolved value", async () => {
    const deferred = await runEffect(
      ExternalResult.register({ sessionID: sessionA, messageID, callID, inputSnapshot: {} }),
    )
    const awaitPromise = Effect.runPromise(Deferred.await(deferred))
    await runEffect(
      ExternalResult.resolveIfPending({
        sessionID: sessionA,
        messageID,
        callID,
        value: { kind: "submitted", payload: 42 },
      }),
    )
    await expect(awaitPromise).resolves.toEqual({ kind: "submitted", payload: 42 })
  })

  test("hasPending counts only pending entries (tombstones excluded)", async () => {
    await runEffect(
      ExternalResult.register({ sessionID: sessionA, messageID, callID, inputSnapshot: {} }),
    )
    await runEffect(
      ExternalResult.resolveIfPending({ sessionID: sessionA, messageID, callID, value: {} }),
    )
    expect(ExternalResult.hasPending(sessionA)).toBe(false)
  })
})

describe("tool.external-result.Registry shutdown semantics", () => {
  test("onSessionDestroyed rejects pending Deferreds with shutdown reason", async () => {
    const deferred = await runEffect(
      ExternalResult.register({ sessionID: sessionA, messageID, callID, inputSnapshot: {} }),
    )
    await runEffect(ExternalResult.onSessionDestroyed(sessionA))
    let caught: unknown
    try {
      await Effect.runPromise(Deferred.await(deferred))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ExternalResult.Error)
    expect((caught as ExternalResult.Error).reason).toBe("shutdown")
    expect(ExternalResult.hasPending(sessionA)).toBe(false)
  })

  test("onSessionDestroyed clears pending and tombstone entries for that session only", async () => {
    await runEffect(
      ExternalResult.register({ sessionID: sessionA, messageID: "m1", callID: "c1", inputSnapshot: {} }),
    )
    await runEffect(
      ExternalResult.register({ sessionID: sessionA, messageID: "m2", callID: "c2", inputSnapshot: {} }),
    )
    await runEffect(
      ExternalResult.resolveIfPending({ sessionID: sessionA, messageID: "m2", callID: "c2", value: {} }),
    )
    await runEffect(
      ExternalResult.register({ sessionID: sessionB, messageID: "m3", callID: "c3", inputSnapshot: {} }),
    )
    await runEffect(ExternalResult.onSessionDestroyed(sessionA))
    expect(ExternalResult.hasPending(sessionA)).toBe(false)
    expect(ExternalResult.lookup({ sessionID: sessionA, messageID: "m1", callID: "c1" }).state).toBe("not_found")
    expect(ExternalResult.lookup({ sessionID: sessionA, messageID: "m2", callID: "c2" }).state).toBe("not_found")
    expect(ExternalResult.hasPending(sessionB)).toBe(true)
  })

  test("onSessionDestroyed on session with no entries is a no-op", async () => {
    await runEffect(ExternalResult.onSessionDestroyed(sessionA))
    expect(ExternalResult.hasPending(sessionA)).toBe(false)
  })
})

describe("tool.external-result.Registry pending snapshot list", () => {
  test("list returns every pending entry with its identifying keys + snapshot", async () => {
    await runEffect(
      ExternalResult.register({ sessionID: sessionA, messageID: "m1", callID: "c1", inputSnapshot: { questions: ["q1"] } }),
    )
    await runEffect(
      ExternalResult.register({ sessionID: sessionB, messageID: "m2", callID: "c2", inputSnapshot: { questions: ["q2"] } }),
    )
    const snapshots = ExternalResult.list()
    expect(snapshots.length).toBe(2)
    expect(snapshots).toEqual(
      expect.arrayContaining([
        { sessionID: sessionA, messageID: "m1", callID: "c1", inputSnapshot: { questions: ["q1"] } },
        { sessionID: sessionB, messageID: "m2", callID: "c2", inputSnapshot: { questions: ["q2"] } },
      ]),
    )
  })

  test("list excludes resolved tombstones and not_found entries", async () => {
    await runEffect(
      ExternalResult.register({ sessionID: sessionA, messageID: "m1", callID: "c1", inputSnapshot: { questions: ["q1"] } }),
    )
    await runEffect(
      ExternalResult.register({ sessionID: sessionA, messageID: "m2", callID: "c2", inputSnapshot: { questions: ["q2"] } }),
    )
    await runEffect(
      ExternalResult.resolveIfPending({ sessionID: sessionA, messageID: "m1", callID: "c1", value: {} }),
    )
    const snapshots = ExternalResult.list()
    expect(snapshots).toEqual([
      { sessionID: sessionA, messageID: "m2", callID: "c2", inputSnapshot: { questions: ["q2"] } },
    ])
  })

  test("list returns an empty array when there is nothing pending", () => {
    expect(ExternalResult.list()).toEqual([])
  })
})

describe("tool.external-result.Registry parallel sessions", () => {
  test("two sessions each have their own pending entry; independent lifecycle", async () => {
    await runEffect(
      ExternalResult.register({ sessionID: sessionA, messageID, callID, inputSnapshot: {} }),
    )
    await runEffect(
      ExternalResult.register({ sessionID: sessionB, messageID, callID, inputSnapshot: {} }),
    )
    expect(ExternalResult.hasPending(sessionA)).toBe(true)
    expect(ExternalResult.hasPending(sessionB)).toBe(true)
    await runEffect(
      ExternalResult.resolveIfPending({ sessionID: sessionA, messageID, callID, value: {} }),
    )
    expect(ExternalResult.hasPending(sessionA)).toBe(false)
    expect(ExternalResult.hasPending(sessionB)).toBe(true)
  })
})
