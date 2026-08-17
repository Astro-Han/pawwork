import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import {
  buildTurnMessagesByUserID,
  messagesBeforeID,
  readSessionMessages,
  readUserMessages,
  userMessageAfterID,
  userMessageBeforeID,
  userMessagesBeforeID,
} from "./session-messages"

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

  test("selects messages before a boundary by position when IDs wrap", () => {
    const older = message("msg_fd0000000000old", "user")
    const boundary = message("msg_000000000000new", "user")

    expect(messagesBeforeID([older, boundary], boundary.id).map((item) => item.id)).toEqual([older.id])
  })

  test("hides messages while a revert boundary is not loaded", () => {
    const loaded = [message("msg_2", "user"), message("msg_3", "assistant", "msg_2")]

    expect(messagesBeforeID(loaded, "msg_1")).toEqual([])
  })

  test("selects visible user messages when the revert boundary is an assistant message", () => {
    const first = message("msg_1", "user")
    const boundary = message("msg_2", "assistant", first.id)
    const reverted = message("msg_3", "user")

    expect(userMessagesBeforeID([first, boundary, reverted], boundary.id).map((item) => item.id)).toEqual([
      first.id,
    ])
  })

  test("navigates user turns around an assistant revert boundary", () => {
    const first = message("msg_1", "user")
    const firstReply = message("msg_2", "assistant", first.id)
    const boundary = message("msg_3", "assistant", first.id)
    const second = message("msg_4", "user")
    const messages = [first, firstReply, boundary, second]

    expect(userMessageBeforeID(messages, boundary.id)?.id).toBe(first.id)
    expect(userMessageAfterID(messages, boundary.id)?.id).toBe(second.id)
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
