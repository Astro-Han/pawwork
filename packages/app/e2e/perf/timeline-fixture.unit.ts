import { describe, expect, test } from "bun:test"
import { buildHeterogeneousScrollSeedText } from "./timeline-fixture"

describe("heterogeneous scroll fixture", () => {
  test("cycles through mixed message shapes without random input", () => {
    const samples = Array.from({ length: 12 }, (_, turn) => buildHeterogeneousScrollSeedText({ run: 2, turn }))
    const combined = samples.join("\n\n")

    expect(samples.every((sample) => sample.includes("scroll fixture run 2"))).toBe(true)
    expect(samples.every((sample) => sample.includes("Tool transcript"))).toBe(true)
    expect(combined).toContain("```ts")
    expect(combined).toContain("```diff")
    expect(combined).toContain("```json")
    expect(combined).toContain("| phase | status |")
    expect(combined).toContain("Reasoning summary")
    expect(combined).toContain("中文混排")
  })
})
