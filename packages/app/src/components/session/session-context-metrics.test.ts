import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { getRecentTurnCache, getSessionCacheAggregate, getSessionContextMetrics } from "./session-context-metrics"

const assistant = (
  id: string,
  tokens: { total?: number; input: number; output: number; reasoning: number; read: number; write: number },
  cost: number,
  providerID = "openai",
  modelID = "gpt-4.1",
) => {
  return {
    id,
    role: "assistant",
    providerID,
    modelID,
    cost,
    tokens: {
      total: tokens.total,
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: {
        read: tokens.read,
        write: tokens.write,
      },
    },
    time: { created: 1 },
  } as unknown as Message
}

const user = (id: string) => {
  return {
    id,
    role: "user",
    cost: 0,
    time: { created: 1 },
  } as unknown as Message
}

const turnAssistant = (
  id: string,
  parentID: string,
  cumulative?: { input: number; read: number; write: number },
  opts?: { summary?: boolean },
) => {
  return {
    id,
    role: "assistant",
    parentID,
    summary: opts?.summary,
    providerID: "openai",
    modelID: "gpt-4.1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    tokensCumulative: cumulative
      ? { input: cumulative.input, output: 0, reasoning: 0, cache: { read: cumulative.read, write: cumulative.write } }
      : undefined,
    time: { created: 1 },
  } as unknown as Message
}

describe("getSessionContextMetrics", () => {
  test("computes totals and usage from latest assistant with tokens", () => {
    const messages = [
      user("u1"),
      assistant("a1", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0.5),
      assistant("a2", { input: 300, output: 100, reasoning: 50, read: 25, write: 25 }, 1.25),
    ]
    const providers = [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4.1": {
            name: "GPT-4.1",
            limit: { context: 1000, output: 100 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.totalCost).toBe(1.75)
    expect(metrics.context?.message.id).toBe("a2")
    expect(metrics.context?.total).toBe(450)
    expect(metrics.context?.usedTokens).toBe(450)
    expect(metrics.context?.effectiveInputLimit).toBe(1000)
    expect(metrics.context?.compactThreshold).toBe(900)
    expect(metrics.context?.usagePercent).toBe(45)
    expect(metrics.context?.usage).toBe(45)
    expect(metrics.context?.providerLabel).toBe("OpenAI")
    expect(metrics.context?.modelLabel).toBe("GPT-4.1")
  })

  test("uses input limit and custom compaction reserve for usage metrics", () => {
    const messages = [assistant("a1", { total: 238_000, input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 1)]
    const providers = [
      {
        id: "openai",
        models: {
          "gpt-4.1": {
            limit: { context: 400_000, input: 272_000, output: 128_000 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers, { compaction: { reserved: 20_000 } })

    expect(metrics.context?.effectiveInputLimit).toBe(272_000)
    expect(metrics.context?.contextWindow).toBe(400_000)
    expect(metrics.context?.usedTokens).toBe(238_000)
    expect(metrics.context?.compactThreshold).toBe(252_000)
    expect(metrics.context?.usagePercent).toBeCloseTo((238_000 / 272_000) * 100, 5)
    expect(metrics.context?.usage).toBe(Math.round((238_000 / 272_000) * 100))
  })

  test("keeps raw usage separate from rounded display usage", () => {
    const messages = [assistant("a1", { total: 696, input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 1)]
    const providers = [
      {
        id: "openai",
        models: {
          "gpt-4.1": {
            limit: { context: 1_000, output: 100 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.usagePercent).toBe(69.6)
    expect(metrics.context?.usage).toBe(70)
  })

  test("selects the latest assistant when only total tokens are reported", () => {
    const messages = [
      assistant("a1", { input: 10, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1),
      assistant("a2", { total: 70_000, input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0.2),
    ]
    const providers = [
      {
        id: "openai",
        models: {
          "gpt-4.1": {
            limit: { context: 100_000, output: 10_000 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.message.id).toBe("a2")
    expect(metrics.context?.usedTokens).toBe(70_000)
  })

  test("treats zero context limit as unknown", () => {
    const messages = [assistant("a1", { total: 20_000, input: 1, output: 1, reasoning: 1, read: 1, write: 1 }, 1)]
    const providers = [
      {
        id: "openai",
        models: {
          "gpt-4.1": {
            limit: { context: 0, output: 0 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.usedTokens).toBe(20_000)
    expect(metrics.context?.effectiveInputLimit).toBeUndefined()
    expect(metrics.context?.compactThreshold).toBeUndefined()
    expect(metrics.context?.usage).toBeNull()
  })

  test("preserves fallback labels and null usage when model metadata is missing", () => {
    const messages = [assistant("a1", { input: 40, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "p-1", "m-1")]
    const providers = [{ id: "p-1", models: {} }]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.providerLabel).toBe("p-1")
    expect(metrics.context?.modelLabel).toBe("m-1")
    expect(metrics.context?.effectiveInputLimit).toBeUndefined()
    expect(metrics.context?.compactThreshold).toBeUndefined()
    expect(metrics.context?.usage).toBeNull()
  })

  test("recomputes when message array is mutated in place", () => {
    const messages = [assistant("a1", { input: 10, output: 10, reasoning: 10, read: 10, write: 10 }, 0.25)]
    const providers = [{ id: "openai", models: {} }]

    const one = getSessionContextMetrics(messages, providers)
    messages.push(assistant("a2", { input: 100, output: 20, reasoning: 0, read: 0, write: 0 }, 0.75))
    const two = getSessionContextMetrics(messages, providers)

    expect(one.context?.message.id).toBe("a1")
    expect(two.context?.message.id).toBe("a2")
    expect(two.totalCost).toBe(1)
  })

  test("returns empty metrics when inputs are undefined", () => {
    const metrics = getSessionContextMetrics(undefined, undefined)

    expect(metrics.totalCost).toBe(0)
    expect(metrics.context).toBeUndefined()
  })
})

describe("getRecentTurnCache", () => {
  test("reads the cumulative token tally of the turn", () => {
    const messages = [user("1"), turnAssistant("2", "1", { input: 150, read: 200, write: 210 })]

    // 200 / (150 + 200 + 210) = 200 / 560 = 35.7%
    expect(getRecentTurnCache(messages)).toEqual({ input: 150, read: 200, write: 210, hitRate: 35.7 })
  })

  test("aggregates across multiple assistant messages under the same user turn", () => {
    const messages = [
      user("1"),
      turnAssistant("2", "1", { input: 100, read: 0, write: 500 }),
      turnAssistant("3", "1", { input: 20, read: 480, write: 10 }),
    ]

    // 480 / (120 + 480 + 510) = 480 / 1110 = 43.2%
    expect(getRecentTurnCache(messages)).toEqual({ input: 120, read: 480, write: 510, hitRate: 43.2 })
  })

  test("shows 0.0% on a cold-start turn that only writes cache", () => {
    const messages = [user("1"), turnAssistant("2", "1", { input: 300, read: 0, write: 1000 })]

    expect(getRecentTurnCache(messages)?.hitRate).toBe(0)
  })

  test("returns null when the turn has no cache activity", () => {
    const messages = [user("1"), turnAssistant("2", "1", { input: 300, read: 0, write: 0 })]

    expect(getRecentTurnCache(messages)).toBeNull()
  })

  test("aggregates only the most recent turn", () => {
    const messages = [
      user("1"),
      turnAssistant("2", "1", { input: 1000, read: 0, write: 0 }),
      user("3"),
      turnAssistant("4", "3", { input: 10, read: 90, write: 10 }),
    ]

    // 90 / (10 + 90 + 10) = 90 / 110 = 81.8%
    expect(getRecentTurnCache(messages)).toEqual({ input: 10, read: 90, write: 10, hitRate: 81.8 })
  })

  test("skips a compaction summary message so it does not mask the user's latest turn", () => {
    const messages = [
      user("1"),
      turnAssistant("2", "1", { input: 10, read: 90, write: 10 }),
      user("c"),
      turnAssistant("s", "c", { input: 5, read: 1000, write: 0 }, { summary: true }),
    ]

    // the summary turn is the newest but is skipped; the user's real "1" turn wins
    expect(getRecentTurnCache(messages)).toEqual({ input: 10, read: 90, write: 10, hitRate: 81.8 })
  })

  test("ignores reverted turns when picking the recent turn", () => {
    const messages = [
      user("1"),
      turnAssistant("2", "1", { input: 10, read: 90, write: 10 }),
      user("3"),
      turnAssistant("4", "3", { input: 5, read: 0, write: 500 }),
    ]

    // revert points at "3": only the "1" turn stays visible
    expect(getRecentTurnCache(messages, "3")).toEqual({ input: 10, read: 90, write: 10, hitRate: 81.8 })
  })

  test("returns null when there is no assistant turn yet", () => {
    expect(getRecentTurnCache([user("1")])).toBeNull()
    expect(getRecentTurnCache([])).toBeNull()
  })
})

describe("getSessionCacheAggregate", () => {
  test("sums cumulative tokens across every visible turn", () => {
    const messages = [
      user("1"),
      turnAssistant("2", "1", { input: 40_000, read: 40_000, write: 0 }),
      user("3"),
      turnAssistant("4", "3", { input: 12_000, read: 108_000, write: 0 }),
    ]

    // read 148,000 / (input 52,000 + read 148,000 + write 0) = 148,000 / 200,000 = 74.0%
    expect(getSessionCacheAggregate(messages)).toEqual({ input: 52_000, read: 148_000, write: 0, hitRate: 74 })
  })

  test("aggregates multiple assistant messages within a turn", () => {
    const messages = [
      user("1"),
      turnAssistant("2", "1", { input: 100, read: 0, write: 500 }),
      turnAssistant("3", "1", { input: 20, read: 480, write: 10 }),
    ]

    // 480 / (120 + 480 + 510) = 480 / 1110 = 43.2%
    expect(getSessionCacheAggregate(messages)).toEqual({ input: 120, read: 480, write: 510, hitRate: 43.2 })
  })

  test("excludes reverted turns", () => {
    const messages = [
      user("1"),
      turnAssistant("2", "1", { input: 10, read: 90, write: 0 }),
      user("3"),
      turnAssistant("4", "3", { input: 5, read: 0, write: 500 }),
    ]

    // revert points at "3": only the "1" turn stays visible -> 90 / (10 + 90) = 90%
    expect(getSessionCacheAggregate(messages, "3")).toEqual({ input: 10, read: 90, write: 0, hitRate: 90 })
  })

  test("skips compaction summary messages", () => {
    const messages = [
      user("1"),
      turnAssistant("2", "1", { input: 10, read: 90, write: 0 }),
      user("c"),
      turnAssistant("s", "c", { input: 5, read: 1000, write: 0 }, { summary: true }),
    ]

    // the summary turn's tokens are ignored: 90 / (10 + 90) = 90%
    expect(getSessionCacheAggregate(messages)).toEqual({ input: 10, read: 90, write: 0, hitRate: 90 })
  })

  test("returns null when no turn reported cache activity", () => {
    const messages = [user("1"), turnAssistant("2", "1", { input: 300, read: 0, write: 0 })]
    expect(getSessionCacheAggregate(messages)).toBeNull()
    expect(getSessionCacheAggregate([])).toBeNull()
  })
})
