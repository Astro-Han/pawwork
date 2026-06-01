import { describe, expect, test } from "bun:test"
import { shouldShowLayoutDebugBar } from "./layout-shell-frame-debug"

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
})
