import type { Event, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { describe, expect, test } from "bun:test"
import { coalesceQueuedEvents, type QueuedGlobalEvent } from "./global-sdk-event-queue"

const directory = "/repo"

const delta = (partID: string, value: string, messageID = "msg_1", field = "text"): Event => ({
  type: "message.part.delta",
  properties: { sessionID: "ses_1", messageID, partID, field, delta: value },
})

const updated = (partID: string, messageID = "msg_1"): Event =>
  ({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      time: 1,
      part: { id: partID, sessionID: "ses_1", messageID, type: "text", text: "full" },
    },
  }) as Event

const status = (sessionID = "ses_1", type: "busy" | "idle" | "retry" = "busy"): Event => ({
  type: "session.status",
  properties: {
    sessionID,
    status: type === "retry" ? ({ type, attempt: 1, message: "retry", next: 1 } satisfies SessionStatus) : { type },
  },
})

const queued = (...events: Event[]): QueuedGlobalEvent[] => events.map((payload) => ({ directory, payload }))
const queuedIn = (directory: string, ...events: Event[]): QueuedGlobalEvent[] =>
  events.map((payload) => ({ directory, payload }))
const eventTypes = (events: QueuedGlobalEvent[]) => events.map((event) => event.payload.type)
const deltas = (events: QueuedGlobalEvent[]) =>
  events
    .filter((event) => event.payload.type === "message.part.delta")
    .map((event) => (event.payload as Extract<Event, { type: "message.part.delta" }>).properties.delta)

describe("global SDK event queue coalescing", () => {
  test("combines only contiguous deltas for the same part", () => {
    const events = coalesceQueuedEvents(queued(delta("prt_1", "a"), delta("prt_1", "b")))

    expect(events).toHaveLength(1)
    expect(deltas(events)).toEqual(["ab"])
  })

  test("does not merge same-part deltas across another part delta", () => {
    const events = coalesceQueuedEvents(queued(delta("prt_1", "a"), delta("prt_2", "x"), delta("prt_1", "b")))

    expect(deltas(events)).toEqual(["a", "x", "b"])
  })

  test("does not merge deltas across non-delta barriers", () => {
    const events = coalesceQueuedEvents(queued(delta("prt_1", "a"), status(), delta("prt_1", "b")))

    expect(eventTypes(events)).toEqual(["message.part.delta", "session.status", "message.part.delta"])
    expect(deltas(events)).toEqual(["a", "b"])
  })

  test("does not merge same-part deltas for different fields", () => {
    const events = coalesceQueuedEvents(
      queued(delta("prt_1", "a", "msg_1", "text"), delta("prt_1", "b", "msg_1", "metadata")),
    )

    expect(deltas(events)).toEqual(["a", "b"])
  })

  test("drops stale deltas before a full part update but keeps later deltas", () => {
    const events = coalesceQueuedEvents(queued(delta("prt_1", "stale"), updated("prt_1"), delta("prt_1", "fresh")))

    expect(eventTypes(events)).toEqual(["message.part.updated", "message.part.delta"])
    expect(deltas(events)).toEqual(["fresh"])
  })

  test("keeps only the full update and later delta for delta-update-delta ordering", () => {
    const events = coalesceQueuedEvents(queued(delta("prt_1", "before"), updated("prt_1"), delta("prt_1", "after")))

    expect(eventTypes(events)).toEqual(["message.part.updated", "message.part.delta"])
    expect(deltas(events)).toEqual(["after"])
  })

  test("handles multiple full updates for the same part without resurrecting stale deltas", () => {
    const events = coalesceQueuedEvents(queued(delta("prt_1", "stale"), updated("prt_1"), updated("prt_1")))

    expect(eventTypes(events)).toEqual(["message.part.updated", "message.part.updated"])
    expect(deltas(events)).toEqual([])
  })

  test("keeps replaceable event indexes correct after stale delta removal", () => {
    const events = coalesceQueuedEvents(
      queued(delta("prt_1", "stale"), status("ses_1", "busy"), updated("prt_1"), status("ses_1", "idle")),
    )

    expect(eventTypes(events)).toEqual(["session.status", "message.part.updated"])
    expect(events[0].payload).toEqual(status("ses_1", "idle"))
  })

  test("keeps delta merging and stale pruning isolated by directory", () => {
    const events = coalesceQueuedEvents([
      ...queuedIn("/repo-a", delta("prt_1", "a")),
      ...queuedIn("/repo-b", delta("prt_1", "b")),
      ...queuedIn("/repo-a", delta("prt_1", "c")),
      ...queuedIn("/repo-a", updated("prt_1")),
      ...queuedIn("/repo-b", delta("prt_1", "d")),
      ...queuedIn("/repo-b", updated("prt_1")),
    ])

    expect(eventTypes(events)).toEqual(["message.part.updated", "message.part.updated"])
    expect(deltas(events)).toEqual([])
    expect(events.map((event) => event.directory)).toEqual(["/repo-a", "/repo-b"])
  })
})
