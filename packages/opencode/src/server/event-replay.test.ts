import { describe, expect, test } from "bun:test"
import { EventReplayStore } from "./event-replay"

describe("EventReplayStore", () => {
  test("replays completed assistant text parts without replaying streaming text", () => {
    const store = new EventReplayStore({ bootID: "boot" })
    const cursor = store.latestID()

    store.append({
      directory: "/repo",
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            sessionID: "ses_1",
            text: "still streaming",
            time: {},
          },
        },
      },
    })
    store.append({
      directory: "/repo",
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            sessionID: "ses_1",
            text: "done",
            time: { end: 1 },
          },
        },
      },
    })

    const replay = store.snapshot(cursor).replay

    expect(replay).toHaveLength(1)
    expect(replay[0].envelope.payload).toEqual({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: "ses_1",
          text: "done",
          time: { end: 1 },
        },
      },
    })
  })

  test("replays question tool updates", () => {
    const store = new EventReplayStore({ bootID: "boot" })
    const cursor = store.latestID()

    store.append({
      directory: "/repo",
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "question",
            sessionID: "ses_1",
            messageID: "msg_1",
            callID: "call_1",
            state: {
              status: "running",
              metadata: { externalResultReady: true },
              input: { questions: [{ question: "Pick one" }] },
            },
          },
        },
      },
    })
    store.append({
      directory: "/repo",
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "bash",
            sessionID: "ses_1",
            messageID: "msg_2",
            callID: "call_2",
          },
        },
      },
    })

    const replay = store.snapshot(cursor).replay

    expect(replay).toHaveLength(1)
    expect(replay[0].envelope.payload.properties).toEqual({
      part: {
        type: "tool",
        tool: "question",
        sessionID: "ses_1",
        messageID: "msg_1",
        callID: "call_1",
        state: {
          status: "running",
          metadata: { externalResultReady: true },
          input: { questions: [{ question: "Pick one" }] },
        },
      },
    })
  })
})
