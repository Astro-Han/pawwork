import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { buildTurnMessagesByUserID, readSessionMessages, readUserMessages } from "./session-messages"

const message = (id: string, role: Message["role"], parentID?: string): Message =>
  ({
    id,
    sessionID: "ses_1",
    role,
    parentID,
    time: { created: 1 },
  }) as Message

describe("session message readers", () => {
  test("returns a stable empty list for missing or invalid session cache values", () => {
    const empty = readSessionMessages(undefined)

    expect(empty).toHaveLength(0)
    expect(Object.isFrozen(empty)).toBe(true)
    expect(readSessionMessages(null)).toBe(empty)
    expect(readSessionMessages({})).toBe(empty)
  })

  test("preserves loaded message arrays", () => {
    const loaded = [message("msg_1", "user"), message("msg_2", "assistant")]

    expect(readSessionMessages(loaded)).toBe(loaded)
  })

  test("filters user messages from a safe message list", () => {
    const loaded = [message("msg_1", "assistant"), message("msg_2", "user")]

    expect(readUserMessages(readSessionMessages(loaded)).map((item) => item.id)).toEqual(["msg_2"])
  })

  test("returns a stable empty user list for missing or invalid inputs", () => {
    const empty = readUserMessages(undefined)

    expect(empty).toHaveLength(0)
    expect(Object.isFrozen(empty)).toBe(true)
    expect(readUserMessages("not an array")).toBe(empty)
  })

  test("skips malformed entries while filtering user messages", () => {
    const loaded = [null, {}, message("msg_1", "assistant"), message("msg_2", "user")]

    expect(readUserMessages(loaded).map((item) => item.id)).toEqual(["msg_2"])
  })
})

describe("session turn message indexing", () => {
  test("groups assistant messages by parent user while preserving current turn scan semantics", () => {
    const loaded = [
      message("early_assistant", "assistant", "user_1"),
      message("user_1", "user"),
      message("assistant_1", "assistant", "user_1"),
      message("user_2", "user"),
      message("assistant_2", "assistant", "user_1"),
      message("assistant_3", "assistant", "user_2"),
      message("orphan_assistant", "assistant"),
      message("unknown_parent", "assistant", "missing_user"),
    ]

    const byUserID = buildTurnMessagesByUserID(loaded)

    expect(byUserID.get("user_1")?.map((item) => item.id)).toEqual(["assistant_1", "assistant_2"])
    expect(byUserID.get("user_2")?.map((item) => item.id)).toEqual(["assistant_3"])
    expect(byUserID.has("missing_user")).toBe(false)
  })

  test("does not allocate per-user empty assistant lists", () => {
    const byUserID = buildTurnMessagesByUserID([message("user_1", "user")])

    expect(byUserID.has("user_1")).toBe(false)
  })
})
