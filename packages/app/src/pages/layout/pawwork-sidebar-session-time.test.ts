import { describe, expect, test } from "bun:test"
import { pawworkSidebarSessionTime } from "./pawwork-session-source"

describe("pawworkSidebarSessionTime", () => {
  test("uses the latest loaded user message time", () => {
    expect(
      pawworkSidebarSessionTime(
        {
          time: {
            created: 100,
            updated: 600,
          },
        },
        [
          { id: "msg_1", role: "assistant", time: { created: 700 } },
          { id: "msg_2", role: "user", time: { created: 300 } },
          { id: "msg_3", role: "user", time: { created: 500 } },
        ],
      ),
    ).toBe(500)
  })

  test("uses API activity time before loaded user messages when activity is available", () => {
    expect(
      pawworkSidebarSessionTime(
        {
          activityAt: 400,
          time: {
            created: 100,
            updated: 600,
          },
        },
        [{ id: "msg_1", role: "user", time: { created: 500 } }],
      ),
    ).toBe(400)
    expect(
      pawworkSidebarSessionTime(
        {
          activityAt: 700,
          time: {
            created: 100,
            updated: 800,
          },
        },
        [{ id: "msg_2", role: "user", time: { created: 500 } }],
      ),
    ).toBe(700)
  })

  test("uses newer eligible loaded user time when activity is stale", () => {
    expect(
      pawworkSidebarSessionTime(
        {
          activityAt: 400,
          time: {
            created: 100,
            updated: 600,
          },
        },
        [{ id: "msg_1", role: "user", time: { created: 500 } }],
        (messageID) => (messageID === "msg_1" ? [{ type: "text" }] : undefined),
      ),
    ).toBe(500)
  })

  test("does not use synthetic-only or compaction loaded user messages when activity is available", () => {
    expect(
      pawworkSidebarSessionTime(
        {
          activityAt: 400,
          time: {
            created: 100,
            updated: 600,
          },
        },
        [
          { id: "msg_1", role: "user", time: { created: 600 } },
          { id: "msg_2", role: "user", time: { created: 500 } },
        ],
        (messageID) =>
          messageID === "msg_1"
            ? [{ type: "text", synthetic: true }]
            : messageID === "msg_2"
              ? [{ type: "compaction" }]
              : undefined,
      ),
    ).toBe(400)
  })

  test("uses real user messages that also include synthetic reminder parts", () => {
    expect(
      pawworkSidebarSessionTime(
        {
          activityAt: 400,
          time: {
            created: 100,
            updated: 600,
          },
        },
        [{ id: "msg_1", role: "user", time: { created: 500 } }],
        (messageID) =>
          messageID === "msg_1"
            ? [
                { type: "text" },
                { type: "text", synthetic: true },
              ]
            : undefined,
      ),
    ).toBe(500)
  })

  test("ignores user messages without a valid created time", () => {
    expect(
      pawworkSidebarSessionTime(
        {
          time: {
            created: 100,
            updated: 600,
          },
        },
        [
          { id: "msg_1", role: "user", time: { created: 300 } },
          { id: "msg_2", role: "user", time: {} },
        ],
      ),
    ).toBe(300)
  })

  test("ignores user messages with non-finite created times", () => {
    expect(
      pawworkSidebarSessionTime(
        {
          time: {
            created: 100,
            updated: 600,
          },
        },
        [
          { id: "msg_1", role: "user", time: { created: 300 } },
          { id: "msg_2", role: "user", time: { created: Number.NaN } },
          { id: "msg_3", role: "user", time: { created: Number.POSITIVE_INFINITY } },
        ],
      ),
    ).toBe(300)
  })

  test("uses the session creation time instead of last update time when messages are missing", () => {
    expect(
      pawworkSidebarSessionTime(
        {
          time: {
            created: 100,
            updated: 300,
          },
        },
        undefined,
      ),
    ).toBe(100)
  })

  test("falls back to 0 when creation time is non-finite", () => {
    expect(pawworkSidebarSessionTime({ time: { created: Number.NaN, updated: 300 } })).toBe(0)
  })

  test("falls back to 0 when creation time is missing", () => {
    expect(pawworkSidebarSessionTime({ time: { updated: 300 } })).toBe(0)
  })
})
