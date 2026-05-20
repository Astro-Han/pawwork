import { describe, expect, test } from "bun:test"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { sessionPermissionRequest } from "./request-tree"

const session = (input: { id: string; parentID?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
  }) as Session

const permission = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
  }) as PermissionRequest

describe("sessionPermissionRequest", () => {
  test("returns undefined without a session id", () => {
    expect(sessionPermissionRequest([], {}, undefined)).toBeUndefined()
  })

  test("returns the permission registered against the active session", () => {
    const result = sessionPermissionRequest(
      [session({ id: "s1" })],
      { s1: [permission("p1", "s1")] },
      "s1",
    )
    expect(result?.id).toBe("p1")
  })

  test("walks the session tree to find descendant permissions", () => {
    const result = sessionPermissionRequest(
      [session({ id: "parent" }), session({ id: "child", parentID: "parent" })],
      { child: [permission("p1", "child")] },
      "parent",
    )
    expect(result?.id).toBe("p1")
  })

  test("respects the include filter", () => {
    const result = sessionPermissionRequest(
      [session({ id: "s1" })],
      { s1: [permission("p1", "s1"), permission("p2", "s1")] },
      "s1",
      (item) => item.id === "p2",
    )
    expect(result?.id).toBe("p2")
  })
})
