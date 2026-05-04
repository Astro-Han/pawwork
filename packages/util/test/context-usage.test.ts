import { describe, expect, test } from "bun:test"
import { contextUsageModelOutputLimit, deriveContextUsage } from "../src/context-usage"

const tokens = (input: {
  total?: number
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
}) => ({
  total: input.total,
  input: input.input ?? 0,
  output: input.output ?? 0,
  reasoning: input.reasoning ?? 0,
  cache: {
    read: input.cacheRead ?? 0,
    write: input.cacheWrite ?? 0,
  },
})

describe("deriveContextUsage", () => {
  test("uses input limit when it is lower than the context window", () => {
    const usage = deriveContextUsage({
      model: { limit: { context: 400_000, input: 272_000, output: 128_000 } },
      tokens: tokens({ total: 238_000 }),
      compaction: {},
      defaultReserveTokens: 20_000,
    })

    expect(usage.usedTokens).toBe(238_000)
    expect(usage.effectiveInputLimit).toBe(272_000)
    expect(usage.compactThreshold).toBe(252_000)
    expect(usage.usagePercent).toBeCloseTo(87.5, 1)
    expect(usage.autoCompactEnabled).toBe(true)
  })

  test("falls back to context window when input limit is missing", () => {
    const usage = deriveContextUsage({
      model: { limit: { context: 128_000, output: 16_000 } },
      tokens: tokens({ input: 40_000, output: 4_000, cacheRead: 8_000, cacheWrite: 1_000, reasoning: 9_000 }),
      compaction: {},
      defaultReserveTokens: 16_000,
    })

    expect(usage.usedTokens).toBe(53_000)
    expect(usage.effectiveInputLimit).toBe(128_000)
    expect(usage.compactThreshold).toBe(112_000)
    expect(usage.usagePercent).toBeCloseTo(41.40625, 5)
  })

  test("preserves explicit zero input limits", () => {
    const usage = deriveContextUsage({
      model: { limit: { context: 128_000, input: 0, output: 16_000 } },
      tokens: tokens({ input: 10_000 }),
      compaction: {},
      defaultReserveTokens: 16_000,
    })

    expect(usage.effectiveInputLimit).toBe(0)
    expect(usage.compactThreshold).toBe(0)
    expect(usage.usagePercent).toBeNull()
  })

  test("treats zero context as unknown", () => {
    const usage = deriveContextUsage({
      model: { limit: { context: 0, output: 16_000 } },
      tokens: tokens({ total: 20_000 }),
      compaction: {},
      defaultReserveTokens: 16_000,
    })

    expect(usage.usedTokens).toBe(20_000)
    expect(usage.effectiveInputLimit).toBeUndefined()
    expect(usage.compactThreshold).toBeUndefined()
    expect(usage.usagePercent).toBeNull()
  })

  test("keeps current total-token truthy precedence and zero fallback behavior", () => {
    const withTotal = deriveContextUsage({
      model: { limit: { context: 100_000, output: 10_000 } },
      tokens: tokens({ total: 70_000, input: 10_000, output: 10_000, cacheRead: 10_000, cacheWrite: 10_000 }),
      compaction: {},
      defaultReserveTokens: 10_000,
    })
    const zeroTotal = deriveContextUsage({
      model: { limit: { context: 100_000, output: 10_000 } },
      tokens: tokens({ total: 0, input: 10_000, output: 2_000, cacheRead: 3_000, cacheWrite: 4_000 }),
      compaction: {},
      defaultReserveTokens: 10_000,
    })

    expect(withTotal.usedTokens).toBe(70_000)
    expect(zeroTotal.usedTokens).toBe(19_000)
  })

  test("respects custom reserve values including zero", () => {
    const custom = deriveContextUsage({
      model: { limit: { context: 100_000, output: 10_000 } },
      tokens: tokens({ input: 1_000 }),
      compaction: { reserved: 50_000 },
      defaultReserveTokens: 10_000,
    })
    const zero = deriveContextUsage({
      model: { limit: { context: 100_000, output: 10_000 } },
      tokens: tokens({ input: 1_000 }),
      compaction: { reserved: 0 },
      defaultReserveTokens: 10_000,
    })

    expect(custom.compactThreshold).toBe(50_000)
    expect(zero.compactThreshold).toBe(100_000)
  })

  test("sanitizes invalid reserve values before threshold math", () => {
    const negative = deriveContextUsage({
      model: { limit: { context: 100_000, output: 10_000 } },
      tokens: tokens({ input: 1_000 }),
      compaction: { reserved: -1 },
      defaultReserveTokens: 10_000,
    })
    const nonFinite = deriveContextUsage({
      model: { limit: { context: 100_000, output: 10_000 } },
      tokens: tokens({ input: 1_000 }),
      compaction: { reserved: Number.NaN },
      defaultReserveTokens: 10_000,
    })

    expect(negative.compactThreshold).toBe(100_000)
    expect(nonFinite.compactThreshold).toBe(90_000)
  })

  test("derives the reserve source from the model output limit", () => {
    expect(contextUsageModelOutputLimit({ limit: { context: 100_000, output: 12_000 } })).toBe(12_000)
    expect(contextUsageModelOutputLimit({ limit: { context: 100_000, output: 0 } })).toBe(0)
    expect(contextUsageModelOutputLimit()).toBeUndefined()
  })

  test("preserves zero output reserve when deriving the compact threshold", () => {
    const usage = deriveContextUsage({
      model: { limit: { context: 100_000, output: 0 } },
      tokens: tokens({ input: 1_000 }),
      compaction: {},
      defaultReserveTokens: contextUsageModelOutputLimit({ limit: { context: 100_000, output: 0 } }),
    })

    expect(usage.compactThreshold).toBe(100_000)
  })

  test("clamps compact threshold when reserve is larger than the effective limit", () => {
    const usage = deriveContextUsage({
      model: { limit: { context: 10_000, output: 50_000 } },
      tokens: tokens({ input: 12_000 }),
      compaction: { reserved: 20_000 },
      defaultReserveTokens: 50_000,
    })

    expect(usage.compactThreshold).toBe(0)
    expect(usage.usagePercent).toBe(120)
  })

  test("reports disabled auto-compact without changing threshold math", () => {
    const usage = deriveContextUsage({
      model: { limit: { context: 100_000, output: 10_000 } },
      tokens: tokens({ input: 1_000 }),
      compaction: { auto: false },
      defaultReserveTokens: 10_000,
    })

    expect(usage.autoCompactEnabled).toBe(false)
    expect(usage.compactThreshold).toBe(90_000)
  })
})
