import { describe, expect, test } from "bun:test"
import { blockedTurnChangeDescription, buildTurnFetchInput } from "./session-turn-changes"
import type { Message as MessageType } from "@opencode-ai/sdk/v2"

const user = (id: string): MessageType =>
  ({
    id,
    role: "user",
    time: { created: 1 },
  }) as MessageType

const assistant = (id: string, parentID?: string | null, completed?: number): MessageType =>
  ({
    id,
    role: "assistant",
    parentID,
    time: { created: 1, completed },
  }) as MessageType

const t = (key: string, params?: Record<string, unknown>) => {
  if (params?.files) return `${key}[${params.files}]`
  if (params?.count) return `, ${key}[${params.count}]`
  return key
}

describe("buildTurnFetchInput", () => {
  test("returns null without a session id", () => {
    expect(buildTurnFetchInput(undefined, [assistant("a1", "u1", 100)])).toBeNull()
  })

  test("keeps only assistant messages needed by the turn fetch contract", () => {
    expect(buildTurnFetchInput("ses_1", [user("u1"), assistant("a1", "u1", 100), assistant("a2")])).toEqual({
      sessionID: "ses_1",
      assistants: [
        { id: "a1", parentID: "u1", completed: 100 },
        { id: "a2", parentID: undefined, completed: undefined },
      ],
    })
  })
})

describe("blockedTurnChangeDescription", () => {
  test("maps known blocked reasons", () => {
    expect(blockedTurnChangeDescription({ reason: "unsupported_size" }, t)).toBe(
      "session.turnChange.blocked.unsupportedSize",
    )
    expect(blockedTurnChangeDescription({ reason: "permission_denied" }, t)).toBe(
      "session.turnChange.blocked.permissionDenied",
    )
    expect(blockedTurnChangeDescription({ reason: "rollback_failed" }, t)).toBe(
      "session.turnChange.blocked.rollbackFailed",
    )
  })

  test("adds a bounded file summary for conflict descriptions", () => {
    expect(
      blockedTurnChangeDescription(
        {
          reason: "conflict",
          files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }, { path: "d.ts" }, { nope: true }],
        },
        t,
      ),
    ).toBe(
      "session.turnChange.blocked.conflict session.turnChange.blocked.files[a.ts, b.ts, c.ts, session.turnChange.blocked.more[1]]",
    )
  })
})
