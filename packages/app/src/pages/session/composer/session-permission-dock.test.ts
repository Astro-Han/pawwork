import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { canPersistPermission, permissionMetadataLines } from "./session-permission-dock"

const request = (always: string[]): PermissionRequest =>
  ({
    id: "perm_1",
    sessionID: "ses_1",
    permission: "automate_manage",
    patterns: ["aut_123"],
    always,
    metadata: { action: "delete", id: "aut_123", title: "Daily repo brief" },
  }) as PermissionRequest

describe("canPersistPermission", () => {
  test("returns false when the request has no always patterns", () => {
    expect(canPersistPermission(request([]))).toBe(false)
  })

  test("returns true when the request has at least one always pattern", () => {
    expect(canPersistPermission(request(["*"]))).toBe(true)
  })
})

describe("permissionMetadataLines", () => {
  test("renders automate_manage delete metadata as a readable confirmation line", () => {
    const t = (key: string | number, params?: Record<string, string | number | boolean>) =>
      `${key}:${params?.title}:${params?.id}`

    expect(permissionMetadataLines(request([]), t)).toEqual([
      "ui.permission.automateManageDelete:Daily repo brief:aut_123",
    ])
  })
})
