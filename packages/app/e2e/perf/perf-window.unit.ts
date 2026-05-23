import { describe, expect, test } from "bun:test"
import { createPerfWindowGuard } from "./perf-window"

describe("perf window guard", () => {
  test("rejects setup-only work inside active measured windows", async () => {
    const guard = createPerfWindowGuard()

    expect(() => guard.assertSetupAllowed("setup")).not.toThrow()
    await expect(
      guard.measure({
        reset: async () => {},
        action: async () => {
          expect(() => guard.assertSetupAllowed("setup")).toThrow("setup must run outside perf measured windows")
        },
        snapshot: async () => "ok",
      }),
    ).resolves.toBe("ok")
    expect(() => guard.assertSetupAllowed("setup")).not.toThrow()
  })

  test("clears active measured window after action failures", async () => {
    const guard = createPerfWindowGuard()

    await expect(
      guard.measure({
        reset: async () => {},
        action: async () => {
          throw new Error("action failed")
        },
        snapshot: async () => "unreachable",
      }),
    ).rejects.toThrow("action failed")
    expect(() => guard.assertSetupAllowed("setup")).not.toThrow()
  })
})
