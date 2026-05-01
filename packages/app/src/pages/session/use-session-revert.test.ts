import type { UserMessage } from "@opencode-ai/sdk/v2"
import { describe, expect, test } from "bun:test"
import { rolledRevertItems } from "./use-session-revert"

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
})
