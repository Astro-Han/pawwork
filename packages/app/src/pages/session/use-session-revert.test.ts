import type { UserMessage } from "@opencode-ai/sdk/v2"
import { describe, expect, test } from "bun:test"
import { rolledRevertItems } from "./use-session-revert"

const message = (id: string) => ({ id, role: "user" }) as UserMessage

describe("session revert", () => {
  test("builds rolled items from the revert message onward using existing line text", () => {
    expect(
      rolledRevertItems({
        revertMessageID: "b",
        messages: [message("a"), message("b"), message("c")],
        lineText: (id) => `line:${id}`,
      }),
    ).toEqual([
      { id: "b", text: "line:b" },
      { id: "c", text: "line:c" },
    ])
  })
})
