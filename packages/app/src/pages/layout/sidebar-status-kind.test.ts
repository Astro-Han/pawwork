import { describe, expect, test } from "bun:test"
import { sidebarStatusKind } from "./sidebar-status-kind"

describe("sidebarStatusKind", () => {
  test("returns time when nothing is happening", () => {
    expect(sidebarStatusKind({ asking: false, busy: false, error: false })).toBe("time")
  })

  test("prefers asking over busy", () => {
    expect(sidebarStatusKind({ asking: true, busy: true, error: false })).toBe("asking")
  })

  test("prefers asking over error", () => {
    expect(sidebarStatusKind({ asking: true, busy: false, error: true })).toBe("asking")
  })

  test("prefers busy over error", () => {
    expect(sidebarStatusKind({ asking: false, busy: true, error: true })).toBe("busy")
  })

  test("returns error when only error is true", () => {
    expect(sidebarStatusKind({ asking: false, busy: false, error: true })).toBe("error")
  })
})
