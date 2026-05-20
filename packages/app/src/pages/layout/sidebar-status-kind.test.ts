import { describe, expect, test } from "bun:test"
import { sidebarStatusKind } from "./sidebar-status-kind"

describe("sidebarStatusKind", () => {
  test("returns time when nothing is happening", () => {
    expect(sidebarStatusKind({ asking: false, busy: false, error: false, unread: false })).toBe("time")
  })

  test("returns unread when only unread is true", () => {
    expect(sidebarStatusKind({ asking: false, busy: false, error: false, unread: true })).toBe("unread")
  })

  test("returns error when only error is true", () => {
    expect(sidebarStatusKind({ asking: false, busy: false, error: true, unread: false })).toBe("error")
  })

  test("prefers asking over busy", () => {
    expect(sidebarStatusKind({ asking: true, busy: true, error: false, unread: false })).toBe("asking")
  })

  test("prefers asking over error", () => {
    expect(sidebarStatusKind({ asking: true, busy: false, error: true, unread: false })).toBe("asking")
  })

  test("prefers asking over unread", () => {
    expect(sidebarStatusKind({ asking: true, busy: false, error: false, unread: true })).toBe("asking")
  })

  test("prefers busy over error", () => {
    expect(sidebarStatusKind({ asking: false, busy: true, error: true, unread: false })).toBe("busy")
  })

  test("prefers busy over unread (busy ring conveys 'wait' better than dot conveys 'come look')", () => {
    expect(sidebarStatusKind({ asking: false, busy: true, error: false, unread: true })).toBe("busy")
  })

  test("prefers error over unread", () => {
    expect(sidebarStatusKind({ asking: false, busy: false, error: true, unread: true })).toBe("error")
  })

  test("all four agent states true: asking wins (highest priority)", () => {
    expect(sidebarStatusKind({ asking: true, busy: true, error: true, unread: true })).toBe("asking")
  })

  test("busy + error + unread (no asking): busy wins", () => {
    expect(sidebarStatusKind({ asking: false, busy: true, error: true, unread: true })).toBe("busy")
  })

  test("error + unread (no asking/busy): error wins", () => {
    expect(sidebarStatusKind({ asking: false, busy: false, error: true, unread: true })).toBe("error")
  })
})
