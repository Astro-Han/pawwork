import { describe, expect, test } from "bun:test"
import { shouldShowLayoutDebugBar } from "./layout-shell-frame-debug"
import { normalizedSidebarWidth } from "./layout-shell-frame-geometry"

function withoutWindow(run: () => void) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  Reflect.deleteProperty(globalThis, "window")
  try {
    run()
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor)
  }
}

describe("LayoutShellFrame", () => {
  test("does not read window in non-browser test environments", () => {
    withoutWindow(() => {
      expect(() => shouldShowLayoutDebugBar()).not.toThrow()
      expect(shouldShowLayoutDebugBar()).toBe(false)
    })
  })

  test("normalizes sidebar geometry across min, normal, and max widths", () => {
    expect(normalizedSidebarWidth({ width: 120, minWidth: 180, maxWidth: 360 })).toBe(180)
    expect(normalizedSidebarWidth({ width: 260, minWidth: 180, maxWidth: 360 })).toBe(260)
    expect(normalizedSidebarWidth({ width: 720, minWidth: 180, maxWidth: 360 })).toBe(360)
  })
})
