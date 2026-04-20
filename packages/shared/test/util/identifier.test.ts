import { describe, expect, mock, test } from "bun:test"

describe("Identifier", () => {
  test("skips biased bytes when generating base62 suffixes", async () => {
    let calls = 0

    mock.module("crypto", () => ({
      randomBytes: (size: number) => {
        calls += 1
        if (calls === 1) return Buffer.from([248, ...Array.from({ length: size - 1 }, () => 61)])
        return Buffer.from(Array.from({ length: size }, () => 61))
      },
    }))

    const { Identifier } = await import("../../src/util/identifier.ts")
    const id = Identifier.create(false, 0)

    expect(id.slice(12)).toBe("z".repeat(14))
  })
})
