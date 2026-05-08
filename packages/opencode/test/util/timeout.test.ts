import { describe, expect, test } from "bun:test"
import { withTimeout } from "../../src/util/timeout"

describe("util.timeout", () => {
  test("should resolve when promise completes before timeout", async () => {
    const fastPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("fast"), 10)
    })

    const result = await withTimeout(fastPromise, 100)
    expect(result).toBe("fast")
  })

  test("should reject when promise exceeds timeout", async () => {
    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("slow"), 200)
    })

    await expect(withTimeout(slowPromise, 50)).rejects.toThrow("Operation timed out after 50ms")
  })

  test("should clear timeout after promise rejection", async () => {
    const original = globalThis.clearTimeout
    let cleared = 0
    globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
      cleared++
      return original(timer)
    }) as typeof clearTimeout

    try {
      await expect(withTimeout(Promise.reject(new Error("boom")), 100)).rejects.toThrow("boom")
      expect(cleared).toBe(1)
    } finally {
      globalThis.clearTimeout = original
    }
  })
})
