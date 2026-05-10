import type { UserMessage } from "@opencode-ai/sdk/v2"
import { describe, expect, test } from "bun:test"
import { nextRestoreTarget, revertRequestPayload, revertSnapshotIsCurrent, rolledRevertItems } from "./use-session-revert"

const message = (id: string) => ({ id, role: "user" }) as UserMessage

describe("session revert", () => {
  test("builds rolled items from the revert message onward using existing line text", () => {
    expect(
      rolledRevertItems({
        revertMessageID: "msg_2",
        messages: [message("msg_10"), message("msg_2"), message("msg_30")],
        lineText: (id) => `line:${id}`,
      }),
    ).toEqual([
      { id: "msg_2", text: "line:msg_2" },
      { id: "msg_30", text: "line:msg_30" },
    ])
  })

  test("selects the next restore target by timeline position instead of id order", () => {
    const messages = [message("msg_10"), message("msg_2"), message("msg_30")]

    expect(nextRestoreTarget(messages, "msg_10")?.id).toBe("msg_2")
    expect(nextRestoreTarget(messages, "msg_30")).toBeUndefined()
    expect(nextRestoreTarget(messages, "missing")).toBeUndefined()
  })

  test("sends only the API payload for revert requests", () => {
    const payload = revertRequestPayload({
      sessionID: "ses_1",
      messageID: "msg_1",
      snapshot: {
        store: {},
        client: {},
        release: () => undefined,
      },
    } as never)

    expect(payload).toEqual({ sessionID: "ses_1", messageID: "msg_1" })
    expect("snapshot" in payload).toBe(false)
    expect("store" in payload).toBe(false)
    expect("client" in payload).toBe(false)
    expect("release" in payload).toBe(false)
  })

  test("rejects stale revert snapshots from an older execution epoch", () => {
    const oldScope = { serverKey: "sidecar", directory: "/repo", epoch: 1 }
    const newScope = { serverKey: "sidecar", directory: "/repo", epoch: 3 }

    expect(
      revertSnapshotIsCurrent({
        scope: oldScope,
        currentScope: () => newScope,
      }),
    ).toBe(false)
    expect(
      revertSnapshotIsCurrent({
        scope: newScope,
        currentScope: () => newScope,
      }),
    ).toBe(true)
  })
})
