import { describe, expect, test } from "bun:test"
import { formatListPermissionTitle } from "../../../src/cli/cmd/tui/routes/session/permission"

describe("formatListPermissionTitle", () => {
  test("falls back when the path is missing", () => {
    expect(formatListPermissionTitle("")).toBe("List directory")
  })

  test("keeps the normalized path when present", () => {
    expect(formatListPermissionTitle(".")).toBe("List .")
  })
})
