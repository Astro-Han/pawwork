import { describe, expect, test } from "bun:test"

describe("randomBase62", () => {
  test("skips biased bytes before mapping to base62", async () => {
    const { randomBase62 } = await import("../../src/util/base62")
    let calls = 0

    const value = randomBase62(4, (size) => {
      calls += 1
      if (calls === 1) return [248, ...Array.from({ length: size - 1 }, () => 61)]
      return Array.from({ length: size }, () => 61)
    })

    expect(value).toBe("zzzz")
    expect(calls).toBe(2)
  })
})
