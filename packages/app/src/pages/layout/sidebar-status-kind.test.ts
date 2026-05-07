import { describe, expect, test } from "bun:test"
import { sidebarStatusKind } from "./sidebar-status-kind"

describe("sidebarStatusKind", () => {
  test("returns time when nothing is happening", () => {
    expect(sidebarStatusKind({ asking: false, busy: false, error: false, pinned: false })).toBe("time")
  })

  test("prefers asking over busy", () => {
    expect(sidebarStatusKind({ asking: true, busy: true, error: false, pinned: false })).toBe("asking")
  })

  test("prefers asking over error", () => {
    expect(sidebarStatusKind({ asking: true, busy: false, error: true, pinned: false })).toBe("asking")
  })

  test("prefers busy over error", () => {
    expect(sidebarStatusKind({ asking: false, busy: true, error: true, pinned: false })).toBe("busy")
  })

  test("returns error when only error is true", () => {
    expect(sidebarStatusKind({ asking: false, busy: false, error: true, pinned: false })).toBe("error")
  })

  test("returns pin when only pinned is true", () => {
    expect(sidebarStatusKind({ asking: false, busy: false, error: false, pinned: true })).toBe("pin")
  })

  test("prefers asking over pin", () => {
    expect(sidebarStatusKind({ asking: true, busy: false, error: false, pinned: true })).toBe("asking")
  })

  test("prefers busy over pin", () => {
    expect(sidebarStatusKind({ asking: false, busy: true, error: false, pinned: true })).toBe("busy")
  })

  test("prefers error over pin", () => {
    expect(sidebarStatusKind({ asking: false, busy: false, error: true, pinned: true })).toBe("error")
  })

  test("prefers pin over time", () => {
    expect(sidebarStatusKind({ asking: false, busy: false, error: false, pinned: true })).toBe("pin")
  })
})
